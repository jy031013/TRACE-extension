import os

model_info_cache = dict()

BASE_DIR = os.path.join(os.path.dirname(__file__), '..', 'models')

def get_model_path_new(model_role):
    return os.path.join(BASE_DIR, model_role, f'pytorch_model.bin')

def ensure_model_file_exists(model_role):
    model_path = get_model_path_new(model_role)
    if os.path.isfile(model_path):
        return model_path

    available_entries = sorted(
        entry for entry in os.listdir(BASE_DIR)
        if os.path.isdir(os.path.join(BASE_DIR, entry))
    ) if os.path.isdir(BASE_DIR) else []
    available_text = ", ".join(available_entries) if available_entries else "(none)"
    raise FileNotFoundError(
        "Missing backend model weights for "
        f"'{model_role}'. Expected file: {model_path}\n"
        "Run `bash download_models.sh` from the project root to download all required models, "
        "then start the server again with `python backend/server.py`.\n"
        f"Currently available model directories under {BASE_DIR}: {available_text}"
    )

def load_model_with_cache(model_role, model_loader):
    '''`model_loader` should return (model, tokenizer, device).'''
    try:
        model_info = model_info_cache[model_role]
    except Exception as err:
        print(f"+++ Model type: {model_role} is not loaded. Trying to load model...")
        model_info = model_loader(ensure_model_file_exists(model_role))

        if model_role not in model_info_cache:
            model_info_cache[model_role] = dict()
        model_info_cache[model_role] = model_info

        print(f"+++ Model type: {model_role} is loaded")
    return model_info
