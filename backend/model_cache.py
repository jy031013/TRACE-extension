import os

model_info_cache = dict()

BASE_DIR = os.path.join(os.path.dirname(__file__), '..', 'models')

def get_model_path_new(model_role):
    return os.path.join(BASE_DIR, model_role, f'pytorch_model.bin')

def load_model_with_cache(model_role, model_loader):
    '''`model_loader` should return (model, tokenizer, device).'''
    try:
        model_info = model_info_cache[model_role]
    except Exception as err:
        print(f"+++ Model type: {model_role} is not loaded. Trying to load model...")
        model_info = model_loader(get_model_path_new(model_role))

        if model_role not in model_info_cache:
            model_info_cache[model_role] = dict()
        model_info_cache[model_role] = model_info

        print(f"+++ Model type: {model_role} is loaded")
    return model_info
