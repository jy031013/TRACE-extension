from .rich_semantic import finer_grain_window

def get_sliding_window_for_files(files: list[tuple[str, str]]):
    """
    Split code windows into sliding windows

    Args:
        files: {
                'file_name': [
                    {
                        'code_window_start_line': 0,
                        'code_window': [],    // code window itself
                    }
                ],
                ...
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
    for file_path, code_windows in files.items():
        for code_window in code_windows:
            for i in range(0, len(code_window["code_window"], max_sliding_size)):
                sliding_window = {
                    "code_window": code_window["code_window"][i:i+max_sliding_size],
                    "file_path": file_path,
                    "start_line_idx": code_window["code_window_start_line"] + i,
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
