import os
from rapidfuzz import fuzz

def find_line_numbers(start_char_pos, end_char_pos, document_in_lines):
    line_idx = []  # 用来存储包含起始和结束字符的行号
    current_char_count = 0  # 当前字符总数，用于确定字符位置
    
    for index, line in enumerate(document_in_lines):
        line_length = len(line)
        next_char_count = current_char_count + line_length  # 下一个位置的字符总数
        
        if start_char_pos < next_char_count and end_char_pos > current_char_count:
            start = max(start_char_pos, current_char_count)
            end = min(next_char_count, next_char_count)

            # 计算交集的大小
            intersection_length = max(0, end - start + 1)
            if intersection_length / len(line.strip()) > 0.75:
                line_idx.append(index)
        
        current_char_count = next_char_count  # 更新当前的字符总数
    
    return line_idx#[1:-1]

def partial_scs(query, document, threshold, left, right):
    result = fuzz.partial_ratio_alignment(query, document, score_cutoff=threshold)
    if result is None or (result.src_end - result.src_start) / len(query) < 0.75:
        return []
    start_char = left + result.dest_start
    end_char = left + result.dest_end
    segments = [{
        'score': result.score,
        'start_char': start_char,
        'end_char': end_char
    }]
    if document[left : start_char].strip() != "":
        left_segments = partial_scs(query, document[left : start_char], threshold, left=left, right=start_char)
    else:
        left_segments = []
    if document[end_char : right].strip() != "":
        right_segments = partial_scs(query, document[end_char : right], threshold, left=end_char, right=right)
    else:
        right_segments = []
    return left_segments + segments + right_segments
  
def find_similar_code_segment(query, original_document_lines, threshold=80):
    """
    Func:
        Find all similar code segments in the document
    Args:
        query: str, the code segment to search
        document: str, the document to search in
        threshold: int, the similarity threshold
    Returns:
        found_segments: list, a list of found segments
                        {
                            "score": int, the similarity score,
                            "matched_lines": list, a list of line numbers where the code is found, indexed from 0
                        }
    """
    if len(query.strip()) < 15:
        return []
    
    found_segments = []
    document = "".join(original_document_lines)

    char_segments = partial_scs(query, document, threshold, left=0, right=len(document))
    for segment in char_segments:
        found_line_range = find_line_numbers(segment['start_char'], segment['end_char'], original_document_lines)
        if found_line_range == []:
            continue
        found_segments.append({
            "score": segment['score'],
            "matched_lines": found_line_range
        })
    return found_segments

def find_clone_in_project(files, query: str, threshold=80, lsp_style=False):
    """
    Func:
        Find all similar code segments in the project
    Args:
        commit: the commit object
        query: str, the code segment to search
        threshold: int, the similarity threshold
        lsp_style: bool, whether to return the LSP style
    Returns:
        found_clones: list, a list of found segments
    """
    found_clones = []
    queries = [
        'if "http" in file:',
        'if "http" in path:',
        'if "http" in model:',
        'if len(models) == 1 and "http" in models[0]:',
        'if "http" in file:'
    ]
    
    for query in queries:
        for file_path, document_lines in files.items():
            found_segments = find_similar_code_segment(query, document_lines, threshold)
            if found_segments != []:
                for segment in found_segments:
                    assert segment["matched_lines"] != []
                    
                    if segment["score"] < threshold:
                        continue
                    if not lsp_style:
                        response = {
                            "file_path": file_path,
                            "score": segment["score"],
                            "matched_lines": segment["matched_lines"]
                        }
                        if response not in found_clones:
                            found_clones.append(response)
                    else:
                        response = {
                            "file_path": file_path,
                            "score": segment["score"],
                            "start": {
                                "line": segment["matched_lines"][0],
                                "col": 0
                            },
                            "end": {
                                "line": segment["matched_lines"][-1],
                                "col": 0
                            }
                        }
                        if response not in found_clones:
                            found_clones.append(response)

    return found_clones

def is_clone_edit(prior_edits: list):
    if len(prior_edits) < 2:
        return False
    
    tgt_edit_code_before = "".join(prior_edits[-1]["before_edit"])
    if tgt_edit_code_before.strip() == "":
        return False
    
    other_edit_code_before = "".join(prior_edits[-2]["before_edit"])
    if other_edit_code_before.strip() == "":
        return False
    
    if fuzz.ratio(tgt_edit_code_before, other_edit_code_before) > 90:
        return tgt_edit_code_before

    return False