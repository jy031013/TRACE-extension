import torch
import torch.nn as nn
import json

from tqdm import tqdm
from rank_bm25 import BM25Okapi
from torch.utils.data import DataLoader, TensorDataset
from transformers import RobertaTokenizer, T5Config, T5ForConditionalGeneration

from .code_window import CodeWindow
from trace.logging import setup_default_logger

logger = setup_default_logger(__name__)

class Locator(nn.Module):
    """
        Build Seqence-to-Sequence.
        
        Parameters:

        * `encoder`- encoder. e.g. roberta
        * `config`- configuration of encoder model. 
        * `mask_id`- the id of mask token. e.g. 50264
    """
    def __init__(self, encoder, config, 
                 inline_mask_id=None, inter_mask_id=None, 
                 keep_token_id=None, delete_token_id=None, replace_token_id=None, 
                 null_token_id=None, insert_token_id=None, block_split_token_id=None):
        super().__init__()
        self.encoder = encoder
        self.config=config
        self.model_type = "codet5"
        self.register_buffer("bias", torch.tril(torch.ones(2048, 2048)))
        self.dense = nn.Linear(config.hidden_size, config.hidden_size)
        self.lm_head = nn.Linear(config.hidden_size, config.vocab_size, bias=False)
        self.lsm = nn.LogSoftmax(dim=-1)
        self.tie_weights()
        
        self.inline_mask_id=inline_mask_id
        self.inter_mask_id=inter_mask_id
        self.keep_token_id=keep_token_id
        self.delete_token_id=delete_token_id
        self.replace_token_id=replace_token_id
        self.null_token_id=null_token_id
        self.insert_token_id=insert_token_id
        self.block_split_token_id=block_split_token_id
        self.label_weight = torch.ones(config.vocab_size) * 1e-3
        self.criterion = nn.CrossEntropyLoss(ignore_index=-1, weight=self.label_weight)
        
    def _tie_or_clone_weights(self, first_module, second_module):
        """ Tie or clone module weights depending of weither we are using TorchScript or not
        """
        if self.config.torchscript:
            first_module.weight = nn.Parameter(second_module.weight.clone())
        else:
            first_module.weight = second_module.weight
                  
    def tie_weights(self):
        """ Make sure we are sharing the input and output embeddings.
            Export to TorchScript can't handle parameter sharing so we are cloning them instead.
        """
        if self.model_type == "codet5":
            # T5 encoder has different embedding module
            self._tie_or_clone_weights(self.lm_head,
                                    self.encoder.embed_tokens)
        else:
            self._tie_or_clone_weights(self.lm_head,
                                   self.encoder.embeddings.word_embeddings)  
                                   
    def forward(self, source_ids=None, source_mask=None, target_ids=None, train=True):   
        outputs = self.encoder(source_ids, attention_mask=source_mask)
        encoder_output = outputs[0].permute([1,0,2]).contiguous()
        hidden_states = torch.tanh(self.dense(encoder_output)).permute([1,0,2]).contiguous()
        lm_logits = self.lm_head(hidden_states).contiguous()
        if train:
            # Flatten the tokens
            active_loss = ((source_ids == self.inter_mask_id) | (source_ids == self.inline_mask_id)).contiguous().view(-1) # find which tokens are masked
            labels = target_ids.contiguous().view(-1)[active_loss] # get the labels of the masked tokens
            filtered_logits = lm_logits.contiguous().view(-1, self.config.vocab_size)[active_loss] # get the logits of the masked tokens

            loss = self.criterion(filtered_logits, labels)
            outputs = loss,loss*active_loss.sum(),active_loss.sum()
            return outputs
        else:
            return lm_logits
   
def make_locator_dataset(sliding_windows: list, prev_edit_hunks: list,
                         locator_tokenizer: RobertaTokenizer, commit_msg: str)-> TensorDataset:
    """
    Func:
        Given a fixed prior edit estimator, select most relevant hunk as prior edit 
        and construct the dataset for locator to infer
    Args:
        sliding_windows: list of dict:
            {
                "code_window": list[str],
                "file_path": file,
                "start_line_idx": 0,
            }
        prev_edit_hunks: list of dict:
            {   
                "id": int, id,
                "type": str, type, ["delete", "insert", "replace"]
                "code_window": list[str | dict], # contain prefix, suffix context
                "inline_labels": list[str],
                "inter_labels": list[str],
                "before_edit": list[str], # exclude prefix context
                "after_edit": list[str], # exclude suffix context
                "file_path": file,
                "id": 0
            }
    """
    source_seqs = []
    hunks = [CodeWindow(edit, "hunk") for edit in prev_edit_hunks]
    for sliding_window in sliding_windows:
        non_overlap_hunks = hunks
        choosen_hunk_ids = [hunk.id for hunk in hunks] # index to hunk id
        tokenized_corpus = [locator_tokenizer.tokenize("".join(hunk.before_edit_region()+hunk.after_edit_region())) for hunk in non_overlap_hunks]

        prior_edits = []
        
        if len(tokenized_corpus) != 0:
            bm25 = BM25Okapi(tokenized_corpus)
            tokenized_query = locator_tokenizer.tokenize("".join(sliding_window["code_window"]))
            retrieval_code = bm25.get_top_n(tokenized_query, tokenized_corpus, n=3) 
            retrieved_index = [tokenized_corpus.index(i) for i in retrieval_code] # get index in choosen_hunk_ids
            prior_edit_id = [choosen_hunk_ids[idx] for idx in retrieved_index] # get corresponding hunk id
            for id in prior_edit_id: # preserve the order
                prior_edits.append([hunk for hunk in hunks if hunk.id == id][0])
        
        source_seq = formalize_locator_input(sliding_window, commit_msg, prior_edits, locator_tokenizer)
        source_seqs.append(source_seq)
        
    if len(source_seqs) == 0:
        return TensorDataset(torch.tensor([]), torch.tensor([]))
    encoded_source_seq = locator_tokenizer(source_seqs, padding="max_length", truncation=True, max_length=512)  # FIXME
    
    source_ids = torch.tensor(encoded_source_seq["input_ids"])
    source_mask = torch.tensor(encoded_source_seq["attention_mask"])
    dataset = TensorDataset(source_ids, source_mask)

    return dataset

def formalize_locator_input(sliding_window: dict, prompt: str, 
                            prior_edits: list[dict], tokenizer: RobertaTokenizer) -> tuple[str, str]:
    """
    Func:
        Given a sliding window, prior edits, and prompt, form the input sequence for locator
    Args:
        sliding_window: one sliding window
        prior_edits: the prior edit hunks selected
    """
    source_seq = "<code_window><inter-mask>"
    for line in sliding_window["code_window"]:
        source_seq += f"<mask>{line}<inter-mask>"
    source_seq += f"<prompt>{prompt}</prompt><prior_edits>"
    source_seq_len = len(tokenizer.encode(source_seq, add_special_tokens=False))
    
    # prepare the prior edits region
    for prior_edit in prior_edits:
        prior_edit_seq = prior_edit.formalize_as_prior_edit(beautify=False, label_num=6)
        prior_edit_seq_len = len(tokenizer.encode(prior_edit_seq, add_special_tokens=False))
        # Allow the last prior edit to be truncated (Otherwise waste input spaces)
        source_seq += prior_edit_seq
        source_seq_len += prior_edit_seq_len
        if source_seq_len + prior_edit_seq_len > 512 - 3: # start of sequence token, end of sequence token and </prior_edits> token
            break
    source_seq += "</prior_edits>"
    
    return source_seq

def load_model_locator(model_path,device):
    config_class, model_class, tokenizer_class = T5Config, T5ForConditionalGeneration, RobertaTokenizer
    locator_config = config_class.from_pretrained('salesforce/codet5-large')
    locator_tokenizer = tokenizer_class.from_pretrained('salesforce/codet5-large')
    encoder = model_class.from_pretrained('salesforce/codet5-large').encoder

    # add special tokens
    new_special_tokens = ["<inter-mask>",
                          "<code_window>", "</code_window>", 
                          "<prompt>", "</prompt>", 
                          "<prior_edits>", "</prior_edits>",
                          "<edit>", "</edit>",
                          "<keep>", "<replace>", "<delete>",
                          "<null>", "<insert>", "<block-split>",
                          "</insert>","<replace-by>", "</replace-by>"]
    locator_tokenizer.add_tokens(new_special_tokens, special_tokens=True)
    encoder.resize_token_embeddings(len(locator_tokenizer))
    locator_config.vocab_size = len(locator_tokenizer)
    
    locator=Locator(encoder=encoder,config=locator_config,
                    inline_mask_id=locator_tokenizer.mask_token_id,
                    inter_mask_id=locator_tokenizer.convert_tokens_to_ids("<inter-mask>"),
                    keep_token_id=locator_tokenizer.convert_tokens_to_ids("<keep>"),
                    delete_token_id=locator_tokenizer.convert_tokens_to_ids("<delete>"),
                    replace_token_id=locator_tokenizer.convert_tokens_to_ids("<replace>"),
                    null_token_id=locator_tokenizer.convert_tokens_to_ids("<null>"),
                    insert_token_id=locator_tokenizer.convert_tokens_to_ids("<insert>"),
                    block_split_token_id=locator_tokenizer.convert_tokens_to_ids("<block-split>"))
    locator.load_state_dict(torch.load(model_path, map_location = device), strict = False)
    locator.to(device)
    return locator, locator_tokenizer

def predict_sliding_windows(prev_edit_hunks, locator, locator_tokenizer, commit_msg, device, sliding_windows):

    """
    Func:
        Given a list of sliding windows, construct locator input, and return predicted labels
    Args:
        prev_edit_hunks: list of dict:
            {   
                "id": int, id,
                "type": str, type, ["delete", "insert", "replace"]
                "code_window": list[str | dict], # contain prefix, suffix context
                "inline_labels": list[str],
                "inter_labels": list[str],
                "before_edit": list[str], # exclude prefix context
                "after_edit": list[str], # exclude suffix context
                "file_path": file,
                "id": 0
            }
        locator: Locator, the locator model
        locator_tokenizer: RobertaTokenizer, the locator tokenizer
        commit_msg: str, the commit message
        device: torch.device, the device to run the model
        sliding_windows: list of dict:
            {
                "code_window": list[str],
                "file_path": file,
                "start_line_idx": 0,
            }
        service_name: str, in ["def&ref", "clone", "diagnose", "normal"]
    Return:
        None. The result is stored in raw_preds, the time cost is saved in record    
    """
    locator_dateset_one_file = make_locator_dataset(sliding_windows, prev_edit_hunks,locator_tokenizer,commit_msg)
    locator_dataloader = DataLoader(locator_dateset_one_file, batch_size=20, shuffle=False)
            
    # predict locations
    locator.eval()
    
    all_preds, all_confidences = locator_predict(locator, locator_tokenizer, device, "multiple files", locator_dataloader)

    all_preds = hardrule_label_correction(all_preds, all_confidences)

    locator_response = {}
    for sliding_window, preds, confidences in zip(sliding_windows, all_preds, all_confidences):
        inter_preds = [p for i, p in enumerate(preds) if i % 2 == 0]
        inline_preds = [p for i, p in enumerate(preds) if i % 2 == 1]
        if set(inter_preds) == set(["<null>"]) and set(inline_preds) == set(["<keep>"]):
            continue
        inter_confidences = [c for i, c in enumerate(confidences) if i % 2 == 0]
        inline_confidences = [c for i, c in enumerate(confidences) if i % 2 == 1]

        # in case that 8 lines of code is still too long for locator, then the number of labels cannot match the number of lines
        if len(inline_preds) != len(sliding_window["code_window"]):
            inline_preds.extend(["<keep>"]*(len(sliding_window["code_window"])-len(inline_preds)))
            inline_confidences.extend([0]*(len(sliding_window["code_window"])-len(inline_confidences)))
        if len(inter_preds) != len(sliding_window["code_window"]) + 1:
            inter_preds.extend(["<keep>"]*(len(sliding_window["code_window"])+1-len(inter_preds)))
            inter_confidences.extend([0]*(len(sliding_window["code_window"])+1-len(inter_confidences)))
        
        assert len(inline_preds) == len(sliding_window["code_window"])
        assert len(inline_preds) == len(inline_confidences)
        assert len(inter_preds) == len(sliding_window["code_window"]) + 1
        assert len(inter_preds) == len(inter_confidences)

        if sliding_window["file_path"] not in locator_response:
            locator_response[sliding_window["file_path"]] = []

        # if ("keras/layers/core.py" in sliding_window["file_path"] or "keras\\layers\\core.py" in sliding_window["file_path"]) and sliding_window["start_line_idx"] > 200:
        #         continue
            
        locator_response[sliding_window["file_path"]].append({
            "code_window_start_line": sliding_window["start_line_idx"],
            "inline_labels": inline_preds,
            "inter_labels": inter_preds,
            "inline_confidences": inline_confidences,
            "inter_confidences": inter_confidences
        })
            
    return locator_response

def locator_predict(locator, locator_tokenizer, device, file_path, locator_dataloader):
    all_preds = []
    all_confidences = []
    for batch in tqdm(locator_dataloader,desc=f"predicting locations on {file_path}",leave=False):
        batch = tuple(t.to(device) for t in batch)
        source_ids,source_mask = batch                  
        with torch.no_grad():
            lm_logits = locator(source_ids=source_ids,source_mask=source_mask, train=False).to(device)
            lm_logits = torch.nn.functional.softmax(lm_logits, dim=-1)
            # extract masked edit operations
            for i in range(lm_logits.shape[0]): # for sample within batch
                output = []
                confidences = []

                # decode and log the whole sequence
                input_logit_sequence = source_ids[i]
                input_string = locator_tokenizer.decode(input_logit_sequence, clean_up_tokenization_spaces=False)

                # output_logit_sequence = torch.argmax(lm_logits[i], dim=-1)
                # output_string = locator_tokenizer.decode(output_logit_sequence, clean_up_tokenization_spaces=False)

                # output_confidence = torch.max(lm_logits[i], dim=-1).values.detach().cpu().numpy()

                for j in range(lm_logits.shape[1]): # for every token
                    if source_ids[i][j] == locator.inline_mask_id or source_ids[i][j] == locator.inter_mask_id: # if is masked
                        pred_label = locator_tokenizer.decode(torch.argmax(lm_logits[i][j]),clean_up_tokenization_spaces=False)
                        if not pred_label.startswith("<") or not pred_label.endswith(">"):
                            pred_label = f"<{pred_label}>"
                        confidence = torch.max(lm_logits[i][j]).item() # Get the confidence value (0-1)
                        if pred_label == "<insert>" and confidence < 0.95: # debug
                            pred_label = "<null>"
                            confidence = lm_logits[i][j][locator_tokenizer.convert_tokens_to_ids("<null>")].item()
                        elif pred_label == "<replace>" and confidence < 0.7: # debug
                            pred_label = "<keep>"
                            confidence = lm_logits[i][j][locator_tokenizer.convert_tokens_to_ids("<keep>")].item()
                        elif pred_label == "<delete>" and confidence < 0.95: # debug
                            pred_label = "<keep>"
                            confidence = lm_logits[i][j][locator_tokenizer.convert_tokens_to_ids("<keep>")].item()
                        elif pred_label == "<block-split>" and confidence < 0.95: #debug
                            pred_label = "<null>"
                            confidence = lm_logits[i][j][locator_tokenizer.convert_tokens_to_ids("<null>")].item()
                        output.append(pred_label)
                        confidences.append(confidence)
                all_preds.append(output)
                all_confidences.append(confidences)

                all_preds_with_confidence = [[pred, confidence] for pred, confidence in zip(output, confidences)]
                str_all_preds_with_confidence = [f"    [{pred}, {confidence}]" for pred, confidence in all_preds_with_confidence]
                logged_all_preds_with_confidence = '\n'.join([
                    '[',
                    ',\n'.join(str_all_preds_with_confidence),
                    ']'
                    ])   # avoid an extra linebreak when preds is empty
                logger.debug(f'>>> [Locator] has predicted labels of lines:\nInput:\n{input_string}\nOutput with confidences:\n{logged_all_preds_with_confidence}')
    
    return all_preds,all_confidences

def hardrule_label_correction(predictions: list[list[str]], confidences: list[list[float]]):
    for prediction, confidence in zip(predictions, confidences):
        if prediction[0] == "<block-split>":
            prediction[0] = "<null>"
        if prediction[-1] == "<block-split>":
            prediction[-1] = "<null>"
        for label_idx, label in enumerate(prediction[1:-1], start=1):
            # <block-split> should be surrounded by <replace>
            if label == "<block-split>" and (prediction[label_idx-1] != "<replace>" or prediction[label_idx+1] != "<replace>"):
                prediction[label_idx] = "<null>"

        # if there are multiple <insert>, you can't have all <delete> within them
        # get the index of <insert>
        insert_idxs = [i for i, label in enumerate(prediction) if label == "<insert>"]
        if len(insert_idxs) <= 1:
            continue
        for i in range(len(insert_idxs)-1):
            insert_begin_idx = insert_idxs[i]
            insert_end_idx = insert_idxs[i+1]
            all_delete = True
            for label in prediction[insert_begin_idx+1:insert_end_idx]:
                if label == "<keep>" or label == "<replace>":
                    all_delete = False
                    break
            
            if all_delete: # we need to change one <insert> to <null>
                start_insert_confidence = confidence[insert_begin_idx]
                end_insert_confidence = confidence[insert_end_idx]
                if start_insert_confidence > end_insert_confidence:
                    prediction[insert_end_idx] = "<null>"
                else:
                    prediction[insert_begin_idx] = "<null>"

    return predictions