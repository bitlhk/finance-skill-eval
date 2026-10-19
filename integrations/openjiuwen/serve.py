"""Production entry: bounded graceful shutdown via supervisor stdin on all OSes."""
import os
import sys
import threading
import uvicorn


def main():
    server = uvicorn.Server(uvicorn.Config('integrations.openjiuwen.worker:app',
        host=os.environ.get('FINANCE_RUNTIME_HOST', '127.0.0.1'),
        port=int(os.environ.get('FINANCE_RUNTIME_PORT', '56362')),
        access_log=False, timeout_graceful_shutdown=35, log_level='warning',
        log_config={'version': 1, 'disable_existing_loggers': False,
                    'formatters': {'safe': {'()': 'integrations.openjiuwen.operational_logging.SafeFormatter'}},
                    'handlers': {'safe': {'class': 'logging.StreamHandler', 'formatter': 'safe', 'stream': 'ext://sys.stderr'}},
                    'loggers': {'uvicorn': {'handlers': ['safe'], 'propagate': False, 'level': 'WARNING'},
                                'uvicorn.error': {'handlers': ['safe'], 'propagate': False, 'level': 'WARNING'}}}))
    def control():
        for line in sys.stdin:
            if line.strip() == 'stop':
                server.should_exit = True
                break
    threading.Thread(target=control, daemon=True).start()
    server.run()


if __name__ == '__main__':
    main()
