import os
import json
import logging
import configparser

from waitress import serve
from flask import Flask, config, request, make_response, jsonify

from trace.mol_service import invoker_interface, locator_interface, generator_interface
from trace.logging import setup_default_logger

app = Flask(__name__)

SUPPORTED_LANGUAGES = ["go", "python", "java", "typescript", "javascript"]

logger = setup_default_logger(__name__)

logger.info("Modules loaded. Starting server...")

def make_plain_text_response(result):
    response = make_response(result, 200)
    response.mimetype = "text/plain; charset=utf-8"
    return response

def make_400_response(err_msg):
    response = make_response(err_msg, 400)
    response.mimetype = "text/plain; charset=utf-8"
    return response

def run_predict(predict_name, predict_func):
    logger.info(f"Running {predict_name}")
    json_str = request.data.decode('utf-8')
    input_json = json.loads(json_str)

    language = input_json["language"]
    if language not in SUPPORTED_LANGUAGES:
        return make_400_response(f"Not supporting language {language} yet.")
    
    logger.debug(f"{predict_name} input: \n{json.dumps(input_json, indent=4)}")

    result = predict_func(input_json)

    logger.debug(f"{predict_name} output: \n{json.dumps(result, indent=4)}")
    logger.info(f"{predict_name} sending output")

    return make_plain_text_response(result)

@app.route('/content', methods=['POST'])
def run_content():
    return run_predict('generator', generator_interface)

@app.route('/trace/invoker', methods=['POST'])
def post_trace_invoker():
    return run_predict('trace-invoker', invoker_interface)

# TODO add file-by-file transfer when scanning the whole project
@app.route('/trace/locator', methods=['POST'])
def post_trace_locator():
    return run_predict('trace-locator', locator_interface)

@app.route('/statistics', methods=['POST'])
def post_statistics():
    json_str = request.data.decode('utf-8')
    input_json = json.loads(json_str)
    logger.debug(f'Accepting statistics: \n{json.dumps(input_json, indent=4)}')

    return make_plain_text_response('ok')

@app.route('/check', methods=['GET'])
def check():
    return jsonify({
        "status": "success",
        "message": "Backend connection is valid!"
    }), 200
    
if __name__ == '__main__':
    # app.run(host='0.0.0.0', port=5001, debug=True)
    config = configparser.ConfigParser()
    config.read(f'{os.path.dirname(__file__)}/server.ini')

    port = int(config['DEFAULT']['ListenPort'])
    while True:
        try:
            serve(app, host=config['DEFAULT']['ListenHost'], port=port, threads=4)
            logger.info("Server closed.")
            break
        except OSError:
            port += 1
            logger.info(f"Port {port-1} is in use, trying port {port}")
