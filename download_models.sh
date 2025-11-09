#!/usr/bin/env bash
set -euo pipefail

# Repository and target directory
REPO_ID="code-philia/TRACE"
TARGET_DIR="$(pwd)/models"
mkdir -p "$TARGET_DIR"

download_subdir() {
    local subpath="$1"   # e.g.: invoker/model/checkpoint-last
    local name="$2"      # e.g.: invoker_model

    local tmp_dir="$TARGET_DIR/tmp_${name}"
    local final_dir="$TARGET_DIR/${name}"

    rm -rf "$tmp_dir" "$final_dir"
    mkdir -p "$tmp_dir"

    echo "Downloading ${subpath} -> ${final_dir}"

    # Only download specified subdirectory, without symlinks
    huggingface-cli download "$REPO_ID" \
        --local-dir "$tmp_dir" \
        --local-dir-use-symlinks False \
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