import json
import logging
import torch

from model_cache import load_model_with_cache
from .utils import *
from .logic_gate import logic_gate
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
        data: dict, the input data from frontend
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
    if len(prev_edit_hunks) == 0:
        return {
            "type": "normal"
        }

    prior_edit_type, gate_info = logic_gate(prev_edit_hunks, lang)
    
    if prior_edit_type != "normal":
        ### SECOND PHASE: discriminate the type of on-going edits
        service = ask_invoker(prev_edit_hunks, invoker, invoker_tokenizer, prior_edit_type, device, lang)
        if service == prior_edit_type:
            print(f"+++ Invoker prediction: {service}")
            return {
                "type": service,
                "info": gate_info
            }
    
    print(f"+++ Invoker prediction: normal, directly activating locator from backend")
    data["prevEditType"] = "normal"
    return locator_interface(data)

def locator_interface(data):
    '''
    This is the interface between backend and frontend for edit location.
    
    If prior edit type is `rename`, `def&ref`, `clone` or `diagnose`. The frontend should retrieve code windows according to the one of these invoker results:

    + def&ref: def and use code windows found by LSP
    + clone: cloned code windows found by LSP
    + diagnose: NEW diagnostic code windows found by LSP (old diagnostics existing before edit should be ignored)
    
    If prior edit type is normal, this function is called by backend `predict_invoker()`. In this case, the frontend should retrieve code windows as follows:
    
    + normal: all files, each file one code window

    (Each code window should be approximately fit into model input size, <=400 tokens)

    Args:
        data: dict, the input data from frontend
        {
            files: {
                'file_name': [
                    {
                        'code_window_start_line': 0,
                        'code_window': [],    // code window itself
                    }
                ],
                ...
            }
        }

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
    prev_edit_hunks = [construct_prev_edit_hunk(prev_edit, lang) for prev_edit in data["prevEdits"]]

    locator, locator_tokenizer, device = load_model_with_cache("locator_model", load_locator)

    # Split all files into sliding windows
    all_files_sliding_windows = get_sliding_window_for_files(data["files"])
    
    # Predict on each sliding window
    return predict_sliding_windows(prev_edit_hunks, locator, locator_tokenizer, data["commitMsg"], device, all_files_sliding_windows, data["prevEditType"])

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
            "prevEditType": str, in ["def&ref", "clone", "diagnose", "normal"]
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
    prev_edit_type = data["prevEditType"]

    return generate_edit(generator, generator_tokenizer, device, code_window, inline_labels, inter_labels, commit_message, prev_edit_hunks, prev_edit_type)


    