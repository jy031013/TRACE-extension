import torch
import time
import torch.nn as nn
import json

from rank_bm25 import BM25Okapi
from transformers import (RobertaTokenizer, T5Config, T5ForConditionalGeneration)
from transformers import RobertaTokenizer
from torch.utils.data import DataLoader, SequentialSampler, TensorDataset

from .code_window import CodeWindow
from navedit.logging import setup_default_logger

logger = setup_default_logger(__name__)

MODEL_CLASSES = {'codet5': (T5Config, T5ForConditionalGeneration, RobertaTokenizer)}

CONTEXT_LENGTH = 5
MODEL_ROLE = "generator"

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")


def load_model_generator(model_path: str, device: torch.device):
    config_class, model_class, tokenizer_class = MODEL_CLASSES["codet5"]
    
    config = config_class.from_pretrained("salesforce/codet5-base")
    tokenizer = tokenizer_class.from_pretrained("salesforce/codet5-base")
    model = model_class.from_pretrained("salesforce/codet5-base")
    new_special_tokens = ["<inter-mask>",
                          "<code_window>", "</code_window>", 
                          "<prompt>", "</prompt>", 
                          "<prior_edits>", "</prior_edits>",
                          "<edit>", "</edit>",
                          "<keep>", "<replace>", "<delete>",
                          "<null>", "<insert>", "<block-split>",
                          "<replace-by>", "</replace-by>",
                          "<feedback>", "</feedback>"]
    tokenizer.add_tokens(new_special_tokens, special_tokens=True)
    
    config.vocab_size = len(tokenizer)
    new_encoder_embedding = nn.Embedding(config.vocab_size, config.d_model)
    model.encoder.embed_tokens = new_encoder_embedding

    model.load_state_dict(torch.load(model_path))
    # below type cannot be correctly parsed by pyright
    model.to(device)     # type: ignore
    return model, tokenizer

def generate_edit(generator, generator_tokenizer, device, code_window, inline_labels, inter_labels, commit_message, prev_edit_hunks, prev_edit_type):
    """
    
    """

    # Check some assertions
    to_edit_lines = []
    for i, label in enumerate(inline_labels):
        if label != "<keep>":
            to_edit_lines.append(i)
    
    assert to_edit_lines == list(range(min(to_edit_lines), max(to_edit_lines)+1))

    if to_edit_lines != []:
        for idx, inter_label in enumerate(inter_labels):
            if inter_label == "<insert>":
                if idx != 0:
                    assert inter_labels[idx] != "<null>" or inter_labels[idx-1] != "<null>"
                else:
                    assert inter_labels[idx] != "<null>"
    # Done checking assertions

    # if is a delete code window, just delete without generator
    if "<replace>" not in inline_labels and "<delete>" in inline_labels and "<insert>" not in inter_labels:
        new_code_window = []
        for line, label in zip(code_window, inline_labels):
            if label == "<keep>":
                new_code_window.append(line)
        return ["".join(new_code_window)]

    selected_prev_edits = select_hunk(code_window, inline_labels, inter_labels, prev_edit_hunks, generator_tokenizer)

    all_source_ids = formalize_generator_input(code_window, inline_labels, inter_labels, commit_message, prev_edit_type, selected_prev_edits, generator_tokenizer)
    sampler = SequentialSampler(all_source_ids)
    eval_dataloader = DataLoader(all_source_ids,sampler=sampler, batch_size=1)

    # decode and log the whole sequence
    input_logit_sequence = all_source_ids.tensors[0]
    input_string = generator_tokenizer.decode(input_logit_sequence, clean_up_tokenization_spaces=False)

    # run model
    generator.eval()
    replacements=[]
    for batch in eval_dataloader:
        batch = tuple(t.to(device) for t in batch)

        source_ids = batch[0]
        source_mask = source_ids.ne(generator_tokenizer.pad_token_id)
        with torch.no_grad():
            outputs = generator.generate(source_ids,
                                    attention_mask=source_mask,
                                    use_cache=True,
                                    num_beams=10,
                                    max_length=512,
                                    num_return_sequences=10,
                                    return_dict_in_generate=True,
                                    output_scores=True
                                )
            sequence_scores = generator.compute_transition_scores(
                outputs.sequences,  # 生成的 token 序列
                outputs.scores,  # 生成过程中每个 step 的 logits
                normalize_logits=True  # 归一化概率
            )
            final_scores = [seq_score.mean().item() for seq_score in sequence_scores]
            preds = outputs.sequences
            preds = preds.reshape(source_ids.size(0), 10, -1)
            preds = preds.cpu().numpy()
            for pred, score in zip(preds[0], final_scores): # batch_size=1
                pred_seq = generator_tokenizer.decode(pred, skip_special_tokens=True,clean_up_tokenization_spaces=False)
                replacements.append((pred_seq, score))

    # Rank by score in decending order
    replacements.sort(key=lambda x: x[1], reverse=True)
    
    logged_output = '\n'.join([f"{r[1]}:\n{r[0]}" for r in replacements])
    logger.debug(f'>>> [Generator] has predicted replacements:\nInput:\n{input_string}\nOutput:\n{logged_output}')
    
    # discard score
    replacements = [r[0] for r in replacements]
    
    if "<replace>" not in inline_labels and "<delete>" not in inline_labels and "<insert>" in inter_labels:
        assert inter_labels.count("<insert>") == 1
        prefix = "".join(code_window[:inter_labels.index("<insert>")])
        suffix = "".join(code_window[inter_labels.index("<insert>")+1:])
        replacements = [prefix + replacement + suffix for replacement in replacements]

    else:
        prefix = "".join(code_window[:min(to_edit_lines)])
        suffix = "".join(code_window[max(to_edit_lines)+1:])
        replacements = [prefix + replacement + suffix for replacement in replacements]


    return replacements

def select_hunk(code_window: list[str], inline_labels: list[str], inter_labels: list[str], prev_eidt_hunks: list[dict], tokenizer: RobertaTokenizer) -> list[dict]:
    """
    Func:
        Select relevant prior edit hunks from all prev edits
    Args:
        code_window: list[str], the code window
        inline_labels: list[str], the inline labels
        inter_labels: list[str], the inter labels
        prev_eidt_hunks: list[dict], all prior edit hunks
        tokenizer: RobertaTokenizer, the tokenizer
    Return:
        prior_edits: list[dict], the selected prior edits
    """
    # form a corpus of BM25 to search from
    non_overlap_hunks = [CodeWindow(edit, "hunk") for edit in prev_eidt_hunks]
    choosen_hunk_ids = [hunk.id for hunk in non_overlap_hunks] # index to hunk id
    tokenized_corpus = [tokenizer.tokenize("".join(hunk.before_edit_region()+hunk.after_edit_region())) for hunk in non_overlap_hunks]

    if len(tokenized_corpus) == 0:
        return []
    bm25 = BM25Okapi(tokenized_corpus)

    # Extract the `to edit part` from the code window
    to_edit_part_line_idx = []
    for idx, inline_label in enumerate(inline_labels):
        if inline_label != "<keep>":
            to_edit_part_line_idx.append(idx)
    
    for idx, inter_label in enumerate(inter_labels):
        if inter_label != "<null>":
            if idx == 0:
                to_edit_part_line_idx.append(0)
            else:
                to_edit_part_line_idx.append(idx)
                to_edit_part_line_idx.append(idx-1)
    start_idx = min(to_edit_part_line_idx)
    end_idx = max(to_edit_part_line_idx)
    to_edit_part = code_window[start_idx:end_idx+1]
    tokenized_query = tokenizer.tokenize("".join(to_edit_part))

    retrieval_code = bm25.get_top_n(tokenized_query, tokenized_corpus, n=3) 
    retrieved_index = [tokenized_corpus.index(i) for i in retrieval_code] # get index in choosen_hunk_ids
    prior_edit_id = [choosen_hunk_ids[idx] for idx in retrieved_index] # get corresponding hunk id
    prior_edits = []
    for id in prior_edit_id: # preserve the order
        prior_edits.append([hunk for hunk in prev_eidt_hunks if hunk["id"] == id][0])
    
    return prior_edits

def formalize_generator_input(sliding_window: list[str], inline_labels: list[str], 
                              inter_labels: list[str], prompt: str, static_msg: str,
                              prior_edits: list[dict], tokenizer) -> TensorDataset:
    """
    Func:
        Construct all elements into the gererator input
    """
    source_seq = f"<feedback>{static_msg}</feedback><code_window>{inter_labels[0]}"
    for idx, (line, inline_label, inter_label) in enumerate(zip(sliding_window, inline_labels, inter_labels[1:])):
        source_seq += f"{inline_label}{line}{inter_label}"
    # prepare the prompt region
    # truncate prompt if it encode to more than 64 tokens
    encoded_prompt = tokenizer.encode(prompt, add_special_tokens=False, max_length=64, truncation=True)
    truncated_prompt = tokenizer.decode(encoded_prompt)
    source_seq += f"</code_window><prompt>{truncated_prompt}</prompt><prior_edits>"
    common_seq_len = len(tokenizer.encode(source_seq, add_special_tokens=False))
    # prepare the prior edits region
    for prior_edit in prior_edits:
        prior_edit = CodeWindow(prior_edit, "hunk")
        prior_edit_seq = prior_edit.formalize_as_prior_edit(beautify=False, label_num=6)
        prior_edit_seq_len = len(tokenizer.encode(prior_edit_seq, add_special_tokens=False))
        # Allow the last prior edit to be truncated (Otherwise waste input spaces)
        source_seq += prior_edit_seq
        common_seq_len += prior_edit_seq_len
        if common_seq_len + prior_edit_seq_len > 512 - 3: # start of sequence token, end of sequence token and </prior_edits> token
            break
    source_seq += "</prior_edits>"
    
    encoded_source_seq = tokenizer(source_seq, padding="max_length", truncation=True, max_length=512)
    source_ids = torch.tensor([encoded_source_seq["input_ids"]], dtype=torch.long)
    data = TensorDataset(source_ids)
    return data
    

