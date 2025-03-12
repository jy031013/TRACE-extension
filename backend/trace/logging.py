import logging

LOGGING_BASIC_FORMAT = '[%(asctime)s][%(name)s][%(levelname)s] %(message)s'
# logging.basicConfig(level=logging.WARNING, format=LOGGING_BASIC_FORMAT)

console_handler = logging.StreamHandler()
console_handler.setFormatter(logging.Formatter(LOGGING_BASIC_FORMAT))
console_handler.setLevel(logging.INFO)

file_handler = logging.FileHandler('server.log')
file_handler.setFormatter(logging.Formatter(LOGGING_BASIC_FORMAT))
file_handler.setLevel(logging.DEBUG)

def setup_default_logger(name: str, to_console: bool = True, to_file: bool = True):
    logger = logging.getLogger(name)
    logger.propagate = False
    logger.setLevel(logging.DEBUG)
    
    if to_console:
        logger.addHandler(console_handler)

    if to_file:
        logger.addHandler(file_handler)
    
    return logger