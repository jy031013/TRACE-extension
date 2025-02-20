import os
from rapidfuzz import fuzz

def is_clone_edit(prior_edits: list):
    if len(prior_edits) < 2:
        return False
    
    tgt_edit_code_before = "".join(prior_edits[-1]["before"])
    if tgt_edit_code_before.strip() == "":
        return False
    
    other_edit_code_before = "".join(prior_edits[-2]["before"])
    if other_edit_code_before.strip() == "":
        return False
    
    if fuzz.ratio(tgt_edit_code_before, other_edit_code_before) > 90:
        return tgt_edit_code_before

    return False