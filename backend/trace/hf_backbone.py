import os
import json
import shutil
import tempfile


PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
LOCAL_HF_ROOT = os.path.join(PROJECT_ROOT, "models", "hf")

LOCAL_MODEL_DIRS = {
    "microsoft/codebert-base": os.path.join(LOCAL_HF_ROOT, "microsoft", "codebert-base"),
    "salesforce/codet5-base": os.path.join(LOCAL_HF_ROOT, "salesforce", "codet5-base"),
    "salesforce/codet5-large": os.path.join(LOCAL_HF_ROOT, "salesforce", "codet5-large"),
}


def resolve_backbone_path(repo_id: str) -> str:
    local_dir = LOCAL_MODEL_DIRS.get(repo_id)
    if local_dir and os.path.isdir(local_dir) and os.listdir(local_dir):
        return local_dir
    return repo_id


def missing_backbone_message(repo_id: str) -> str:
    local_dir = LOCAL_MODEL_DIRS.get(repo_id)
    if not local_dir:
        return f"Required backbone model '{repo_id}' is unavailable."
    return (
        f"Required backbone model '{repo_id}' is unavailable.\n"
        f"Expected local directory: {local_dir}\n"
        "Run `bash download_backbone_models.sh` from the project root to download "
        "the required Hugging Face backbone models, then retry starting the backend."
    )


def _sanitize_special_tokens(value):
    if isinstance(value, dict):
        if "content" in value:
            return value["content"]
        return {key: _sanitize_special_tokens(inner) for key, inner in value.items()}
    if isinstance(value, list):
        return [_sanitize_special_tokens(inner) for inner in value]
    return value


def resolve_tokenizer_path(repo_id: str) -> str:
    backbone_path = resolve_backbone_path(repo_id)
    if not os.path.isdir(backbone_path):
        return backbone_path

    temp_dir = tempfile.mkdtemp(prefix="trace_hf_tokenizer_")
    for entry in os.listdir(backbone_path):
        src_path = os.path.join(backbone_path, entry)
        dst_path = os.path.join(temp_dir, entry)
        if os.path.isfile(src_path):
            shutil.copy2(src_path, dst_path)

    for file_name in ("tokenizer_config.json", "special_tokens_map.json"):
        file_path = os.path.join(temp_dir, file_name)
        if not os.path.isfile(file_path):
            continue
        with open(file_path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        with open(file_path, "w", encoding="utf-8") as handle:
            json.dump(_sanitize_special_tokens(data), handle)

    return temp_dir
