"""Public Python HTTP entry; compatible with the deployment stop channel."""
import asyncio
import logging
import uvicorn
from runtime.process_control import start_stop_channel
from .configuration import load_configuration
from .server import create_application


def main():
    configuration = load_configuration()
    app = create_application(configuration)
    server = uvicorn.Server(uvicorn.Config(app, host=configuration['host'], port=configuration['port'],
        access_log=False, timeout_graceful_shutdown=40, log_level='info'))
    # Only graceful shutdown uses stdin; application traffic stays HTTP/SSE.
    start_stop_channel(lambda: setattr(server, 'should_exit', True))
    logging.getLogger('finance.api').info('Python HTTP service starting')
    asyncio.run(server.serve())


if __name__ == '__main__':
    main()
