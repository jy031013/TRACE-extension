import json
import logging
import torch

from model_cache import load_model_with_cache
from .utils import *
from .logic_gate import logic_gate
from .logic_gate.is_clone import find_clone_in_project
from .invoker import load_model_invoker, ask_invoker
from .locator import load_model_locator, predict_sliding_windows
from .generator import load_model_generator, generate_edit

def load_invoker(checkpoint_path):
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    invoker_model, invoker_tokenizer = load_model_invoker(checkpoint_path, device)
    return invoker_model, invoker_tokenizer, device

def load_locator(checkpoint_path):
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    locator_model, locator_tokenizer = load_model_locator(checkpoint_path, device)
    return locator_model, locator_tokenizer, device

def load_generator(checkpoint_path):
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    generator_model, generator_tokenizer = load_model_generator(checkpoint_path, device)
    return generator_model, generator_tokenizer, device

def invoker_interface(data):
    """
    This is the interface between backend and frontend for edit invoker.
    This function predicts whether the last edit belongs to a pre-defined edit composition
    
    Args:
        data: dict, the input data from frontend: 
        {
            "language": str, in ["go", "python", "java", "typescript", "javascript"],
            "prevEdits": list[dict], dict structure:
            {
                "path": str, file path
                "line": int, the line index where the edit happens,
                "rmLine": int, the number of lines being removed,
                "rmText": list[str], the lines being removed, each str is a line of code
                "addLine": int, the number of lines being added,
                "addText": list[str], the lines being added, each str is a line of code
                "codeAbove": str, the code context above the edit
                "codeBelow": str, the code context below the edit
            }
            "files": dict, dict structure:
            {
                "file_path": list[str], each str is a line of code
            }
            "commitMsg": str, the commit message
            "lspServiceName": str | None, in ["def&ref", "clone", "diagnose", "normal"] # rename is excluded, as it can be processed by frontend LSP directly,
            "lspFoundLocations": list[dict] | list[None], dict structure:
            {
                "file_path": str,
                "start": {
                    "line": int,
                    "col": int
                },
                "end": {
                    "line": int,
                    "col": int
                }
            }
        }
    
    Return:
        if last edit is a normal edit, this function will directly call locator and return predicted edit labels
        otherwise, send edit composition type to front end
    """
    lang = data["language"]
    # Transform the 3 label representation to 6 label representation
    prev_edit_hunks = [construct_prev_edit_hunk(prev_edit, lang) for prev_edit in data["prevEdits"]]

    # Activate invoker models
    invoker, invoker_tokenizer, device = load_model_with_cache("invoker_model", load_invoker)

    ### STARTING PHASE: judges the type of primitive edit
    # (NOTE logic gate only discriminates the last edit!)
    # (prior_edit_type = "rename" | "def&ref" | "clone" | "normal")
    # (gate_info contains refactor information like rename) 
    # Due to code logic, clone, diagnose can be not predicted by invoker
    if len(prev_edit_hunks) == 0:
        print("+++ No prevEdits, skip invoker, Locator scanning all files.")
        return locator_interface(data)

    prior_edit_type, gate_info = logic_gate(prev_edit_hunks, lang)
    
    if prior_edit_type != "normal":
        ### SECOND PHASE: discriminate the type of on-going edits
        service = ask_invoker(prev_edit_hunks, invoker, invoker_tokenizer, prior_edit_type, device, lang)
        if service == prior_edit_type:
            print(f"+++ Invoker prediction: {service}, sending LSP request information backto frontend LSP.")
            assert service in ["rename", "def&ref"]
            return {
                "type": service,
                "info": gate_info
            }
            
    elif data["lspServiceName"] in ["diagnose"] and len(data["lspFoundLocations"]) > 0:
        print("+++ prevEdit has caused diagnoses, skip invoker, directly sending diagnose location to Locator.")
        return locator_interface(data)
    
    elif (len(data["prevEdits"]) > 0):
        # find clones on backend
        # this could probably find some clones
        query = "".join(data["prevEdits"][-1]["rmText"])
        if query.strip() != "":
            clones = find_clone_in_project(data["files"], query, lsp_style=True)
            if clones != []:
                data["lspServiceName"] = "clone"
                data["lspFoundLocations"] = clones
                print(f"+++ Invoker prediction: normal, but code clone detector found some location, sending to Locator")
                return locator_interface(data)
    
    print(f"+++ Invoker prediction: normal, Locator scanning all files.")
    data["lspServiceName"] = "normal"
    return locator_interface(data)

def locator_interface(data):
    '''
    This is the interface between backend and frontend for edit location.
    
    Args:
        Please refer to `invoker_interface()` for the expected input data structure.
        
    Returns:
        {
            files: {
                'file_name': [
                    {
                        'code_window_start_line': 0,
                        'inline_labels': list[str],
                        'inter_labels': list[str],
                        'inline_confidences': list[str],
                        'inter_confidences': list[str],
                        'service_name': str, in ["def&ref", "clone", "diagnose", "normal"]
                    }
                ],
                ...
            }
        }
    '''
    if "language" not in data: 
        raise ValueError("`language` not specified in the input data.")
    
    lang = data["language"]
    if type(lang) != str:
        raise ValueError("`language` should be a string.")
    prev_edit_hunks = [construct_prev_edit_hunk(prev_edit, lang) for prev_edit in data["prevEdits"]]    # this will set all ids of previous edits to 0

    for i, hunk in enumerate(prev_edit_hunks):
        hunk['id'] = i

    locator, locator_tokenizer, device = load_model_with_cache("locator_model", load_locator)

    prediction_result = {}

    # Step 1: if provide any lspFoundLocations, directly call locator on those code windows
    if data["lspServiceName"] in ["def&ref", "clone", "diagnose"] and data["lspFoundLocations"] is not []:
        sliding_windows = get_sliding_window_for_lsp_locations(data["files"], data["lspFoundLocations"])
        prediction_result = predict_sliding_windows(prev_edit_hunks, locator, locator_tokenizer, data["commitMsg"], device, sliding_windows)
        
    # Step 2: check if those windows contain any edit-able locations predicted by locator
    # If so, directly return those locations
    if prediction_result != {}:
        return {
            "files": prediction_result
        }
    
    # Step 3: if no edit-able locations are found, split all files into sliding windows
    all_files_sliding_windows = get_sliding_window_for_files(data["files"])
    
    # Predict on each sliding window
    prediction_result = predict_sliding_windows(prev_edit_hunks, locator, locator_tokenizer, data["commitMsg"], device, all_files_sliding_windows)
    return {
        "files": prediction_result
    }

def generator_interface(data):
    """
    This is the interface between backend and frontend for edit content generation

    Args:
        data: dict 
        {
            "language": str, in ["go", "python", "java", "typescript", "javascript"],
            "filePath": str, file path
            "atLine": int, the line index, start from 0
            "codeWindow": str[str], with prefix and suffix context,
            "interLabels": str[str], in ["<null>", "<insert>", "<block-split>"],
            "inlineLabels": str[str], in ["<keep>", "<delete>", "<replace>"],
            "commitMessage": str,
            "prevEdits": list[dict], refer to `construct_prev_edit_hunk()` at `./utils.py` for expected structure
            "lspServiceName": str, in ["def&ref", "clone", "diagnose", "normal"]
        }

    Returns:

    """
    if "language" not in data: 
        raise ValueError("`language` not specified in the input data.")
    
    lang = data["language"]
    if type(lang) != str:
        raise ValueError("`language` should be a string.")
    prev_edit_hunks = [construct_prev_edit_hunk(prev_edit, lang) for prev_edit in data["prevEdits"]]

    generator, generator_tokenizer, device = load_model_with_cache("generator_model", load_generator)

    code_window = data["codeWindow"]
    inline_labels = data["inlineLabels"]
    inter_labels = data["interLabels"]
    commit_message = data["commitMessage"]
    lsp_service_name = data["lspServiceName"]

    return generate_edit(generator, generator_tokenizer, device, code_window, inline_labels, inter_labels, commit_message, prev_edit_hunks, lsp_service_name)

# Load all models immediately
load_model_with_cache("invoker_model", load_invoker)
load_model_with_cache("locator_model", load_locator)
load_model_with_cache("generator_model", load_generator)
