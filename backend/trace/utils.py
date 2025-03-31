import math
import torch
from .rich_semantic import finer_grain_window

def get_sliding_window_for_lsp_locations(files: dict, lsp_locations: list[dict]):
    """
    Get sliding windows for lsp locations
    
    Args:
        files: dict, of the form:
        {
            "file_path": list[str], each str is a line of code
        }
        lsp_locations: list[dict], each dict is a lsp location, of the form:
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
    
    Returns:
        sliding_windows: list of dict:
            {
                "code_window": list[str],
                "file_path": file,
                "start_line_idx": int,
            }
    """
    DEFAULT_NUM_LINES_OF_WINDOW = 10

    sliding_windows = []
    for location in lsp_locations:
        file_path = location["file_path"]
        if file_path not in files:
            continue

        start_line_idx = location["start"]["line"]
        end_line_idx = location["end"]["line"]
        location_range = end_line_idx - start_line_idx + 1
        multiple = math.ceil(location_range / DEFAULT_NUM_LINES_OF_WINDOW)
        prefix_context_length = (DEFAULT_NUM_LINES_OF_WINDOW*multiple  - location_range) // 2
        suffix_context_length = DEFAULT_NUM_LINES_OF_WINDOW*multiple - location_range - prefix_context_length

        window_start_line_idx = max(0, start_line_idx - prefix_context_length)
        window_end_line_idx = min(len(files[file_path]) - 1, end_line_idx + suffix_context_length) + 1
        for i in range(window_start_line_idx, window_end_line_idx, DEFAULT_NUM_LINES_OF_WINDOW):
            code_window = files[file_path][i:i+DEFAULT_NUM_LINES_OF_WINDOW]
            sliding_windows.append({
                "code_window": code_window,
                "file_path": file_path,
                "start_line_idx": i,
            })
    return sliding_windows

def get_sliding_window_for_files(files: dict):
    """
    Split code windows into sliding windows

    Args:
        files: dict, of the form:
        {
            "file_path": list[str], each str is a line of code
        }
    
    Returns:
        sliding_windows: list of dict:
            {
                "code_window": list[str],
                "file_path": file,
                "start_line_idx": 0,
            }
    """
    max_sliding_size = 8
    sliding_windows = []
    for file_path, file_content in files.items():
        for i in range(0, len(file_content), max_sliding_size):
            sliding_window = {
                "code_window": file_content[i:i+max_sliding_size],
                "file_path": file_path,
                "start_line_idx": i,
            }
            sliding_windows.append(sliding_window)
    return sliding_windows

def construct_prev_edit_hunk(edit: dict, lang: str):
    """
    Func:
        Represent prior edit hunks with enriched edit representation
    Args:
        edit: a prior edit like:
            {
                "path": "/home/workspace/test/tmp.py",
                "line": 0,
                "rmLine": 1,
                "rmText": [
                    "def hello_world(name):\n"
                ],
                "addLine": 1,
                "addText": [
                    "def hello_world():\n"
                ],
                "codeAbove": [],
                "codeBelow": [
                    "    print(f\"hello world!, {name}\")",
                    "",
                    "if __name__ == \"__main__\":"
                ]
            }
        lang: str, the language of the code ["python", "java", "go", "javascript", "typescript"]
    Return:
        hunk: dict, the enriched edit representation
    """
    # print("From backend/naveidt/mol_service.py:construct_prev_edit_hunk():")
    # print("Edits:")
    # print(json.dumps(edit,indent=4))
    
    if edit["rmText"] == [] and edit["addText"] != []: # insert type
        hunk = {
            "id": 0,
            "type": "insert",
            "code_window": edit["codeAbove"] + edit["rmText"] + edit["codeBelow"],
            "inline_labels": ["keep"]*len(edit["codeAbove"])+ ["keep"]*len(edit["codeBelow"]),
            "inter_labels": ["null"] * len(edit["codeAbove"]) + ["insert"] + ["null"] * len(edit["codeBelow"]),
            "before_edit": edit["rmText"],
            "after_edit": edit["addText"],
            "edit_start_line_idx": edit["line"]
        }
        
    elif edit["rmText"] != [] and edit["addText"] == []: # delete type
        hunk = {
            "id": 0,
            "type": "delete",
            "code_window": edit["codeAbove"] + edit["rmText"] + edit["codeBelow"],
            "inline_labels": ["keep"]*len(edit["codeAbove"])+ ["delete"]* len(edit["rmText"]) + ["keep"]*len(edit["codeBelow"]),
            "inter_labels": ["null"] * (len(edit["codeAbove"]) + len(edit["rmText"]) + len(edit["codeBelow"])),
            "before_edit": edit['rmText'],
            "after_edit": edit['addText'],
            "edit_start_line_idx": edit["line"]
        }
    
    else:
        code_blocks = finer_grain_window(edit["rmText"], edit["addText"], lang)
        
        inline_labels = ["keep"] * len(edit["codeAbove"])
        inter_labels = ["null"] * len(edit["codeAbove"])
        inter = "null"
        for block in code_blocks:
            if block["block_type"] == "insert":
                inter = "insert"
            elif block["block_type"] == "delete":
                if inter == "block-split":
                    inter_labels.append("null")
                else: # only allow insert or null
                    inter_labels.append(inter)
                inter = "null"
                inline_labels += ["delete"] * len(block["before"])
                inter_labels += ["null"] * (len(block["before"]) - 1)
            elif block["block_type"] == "modify":
                inter_labels.append(inter)
                inter = "block-split"
                inline_labels += ["replace"] * len(block["before"])
                inter_labels += ["null"] * (len(block["before"]) - 1)
        if inter == "block-split":
            inter_labels.append("null")
        else:
            inter_labels.append(inter)
            
        inline_labels += ["keep"] * len(edit["codeBelow"])
        inter_labels += ["null"] * len(edit["codeBelow"])
        assert len(inline_labels) + 1 == len(inter_labels)
        hunk = {
            "id": 0,
            "type": "replace",
            "code_window": edit["codeAbove"] + code_blocks + edit["codeBelow"],
            "inline_labels": inline_labels,
            "inter_labels": inter_labels,
            "before_edit": edit['rmText'],
            "after_edit": edit['addText'],
            "edit_start_line_idx": edit["line"]
        }
        
    # print("Hunk:")
    # print(json.dumps(hunk, indent = 4))
    return hunk

def get_device():
    if torch.cuda.is_available():
        return torch.device("cuda")
    elif torch.backends.mps.is_available():
        return torch.device("mps")
    else:
        return torch.device("cpu")
