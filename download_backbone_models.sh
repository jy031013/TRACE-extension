#!/usr/bin/env bash
set -euo pipefail

TARGET_ROOT="$(pwd)/models/hf"

if [ -x "$(pwd)/.venv/bin/hf" ]; then
    HF_CLI=("$(pwd)/.venv/bin/hf" download)
    HF_LOCAL_DIR_ARGS=(--local-dir)
elif command -v hf >/dev/null 2>&1; then
    HF_CLI=(hf download)
    HF_LOCAL_DIR_ARGS=(--local-dir)
elif command -v huggingface-cli >/dev/null 2>&1; then
    HF_CLI=(huggingface-cli download)
    HF_LOCAL_DIR_ARGS=(--local-dir --local-dir-use-symlinks False)
else
    echo "❌ Error: neither 'hf' nor 'huggingface-cli' is available."
    echo "   Install huggingface_hub in your active Python environment first."
    exit 1
fi

download_repo() {
    local repo_id="$1"
    local relative_dir="$2"
    local target_dir="$TARGET_ROOT/$relative_dir"

    if [ -f "$target_dir/config.json" ] && [ -f "$target_dir/tokenizer.json" ] && { [ -f "$target_dir/model.safetensors" ] || [ -f "$target_dir/pytorch_model.bin" ]; }; then
        echo "✅ Backbone already exists: $target_dir"
        return
    fi

    mkdir -p "$target_dir"
    echo "Downloading backbone ${repo_id} -> ${target_dir}"
    "${HF_CLI[@]}" "$repo_id" "${HF_LOCAL_DIR_ARGS[@]}" "$target_dir"
    echo "✅ Saved to ${target_dir}"
}

download_repo "microsoft/codebert-base" "microsoft/codebert-base"
download_repo "salesforce/codet5-base" "salesforce/codet5-base"
download_repo "salesforce/codet5-large" "salesforce/codet5-large"

echo "🎉 All backbone models saved under: $TARGET_ROOT"
