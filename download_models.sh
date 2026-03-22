#!/usr/bin/env bash
set -euo pipefail

# Repository and target directory
REPO_ID="code-philia/TRACE"
TARGET_DIR="$(pwd)/models"
mkdir -p "$TARGET_DIR"

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

download_subdir() {
    local subpath="$1"   # e.g.: invoker/model/checkpoint-last
    local name="$2"      # e.g.: invoker_model

    local tmp_dir="$TARGET_DIR/tmp_${name}"
    local final_dir="$TARGET_DIR/${name}"

    rm -rf "$tmp_dir" "$final_dir"
    mkdir -p "$tmp_dir"

    echo "Downloading ${subpath} -> ${final_dir}"

    # Only download specified subdirectory, without symlinks
    "${HF_CLI[@]}" "$REPO_ID" \
        "${HF_LOCAL_DIR_ARGS[@]}" "$tmp_dir" \
        --include "${subpath}/*"

    # If nothing was downloaded, exit with error to avoid issues with mv later
    if [ ! -d "$tmp_dir/$subpath" ]; then
        echo "❌ Error: no files downloaded for subpath '${subpath}'."
        echo "   Please check if the subpath is correct, or manually confirm the directory exists on the web page."
        exit 1
    fi

    mkdir -p "$final_dir"

    # Move including hidden files
    shopt -s dotglob nullglob
    mv "$tmp_dir/${subpath}/"* "$final_dir"/
    shopt -u dotglob nullglob

    rm -rf "$tmp_dir"
    echo "✅ Saved to ${final_dir}"
}

download_subdir "invoker/model/checkpoint-last" "invoker_model"
download_subdir "generator/model_6/all/checkpoint-last" "generator_model"
download_subdir "locator/model_6/all/checkpoint-last" "locator_model"

echo "🎉 All models saved under: $TARGET_DIR"
