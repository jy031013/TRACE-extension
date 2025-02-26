import os
import json
import logging
import configparser

from waitress import serve
from flask import Flask, config, request, make_response
from navedit.mol_service import invoker_interface, locator_interface, generator_interface

app = Flask(__name__)

SUPPORTED_LANGUAGES = ["go", "python", "java", "typescript", "javascript"]

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

logger.info("Modules loaded. Server ready.")

def make_plain_text_response(result):
    response = make_response(result, 200)
    response.mimetype = "text/plain; charset=utf-8"
    return response

def make_400_response(err_msg):
    response = make_response(err_msg, 400)
    response.mimetype = "text/plain; charset=utf-8"
    return response

def run_predict(predict_name, predict_func):
    print(f">>> Running {predict_name}")
    json_str = request.data.decode('utf-8')
    input_json = json.loads(json_str)

    language = input_json["language"]
    if language not in SUPPORTED_LANGUAGES:
        return make_400_response(f"Not supporting language {language} yet.")
    
    logger.debug(f"{predict_name} inferencing: \n${json.dumps(input_json, indent=4)}")

    result = predict_func(input_json)

    logger.debug(f"{predict_name} output: \n${json.dumps(result, indent=4)}")
    logger.info(f"{predict_name} sending output")

    return make_plain_text_response(result)

@app.route('/content', methods=['POST'])
def run_content():
    return run_predict('generator', generator_interface)

@app.route('/navedit/invoker', methods=['POST'])
def post_navedit_invoker():
    return run_predict('navedit-invoker', invoker_interface)

# TODO add file-by-file transfer when scanning the whole project
@app.route('/navedit/locator', methods=['POST'])
def post_navedit_locator():
    return run_predict('navedit-locator', locator_interface)

if __name__ == '__main__':
    # app.run(host='0.0.0.0', port=5001, debug=True)
    config = configparser.ConfigParser()
    config.read(f'{os.path.dirname(__file__)}/server.ini')
    serve(app, host=config['DEFAULT']['ListenHost'], port=config['DEFAULT']['ListenPort'])
