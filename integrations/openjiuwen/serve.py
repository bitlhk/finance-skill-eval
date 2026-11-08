"""Production entry: bounded graceful shutdown via supervisor stdin on all OSes."""
import os
import uvicorn
from runtime.process_control import start_stop_channel


def main():
    agent = os.environ.get('FINANCE_RUNTIME_COMPONENT') == 'agent-runtime'
    server = uvicorn.Server(uvicorn.Config('integrations.openjiuwen.migration_runtime:app' if agent else 'integrations.openjiuwen.worker:app',
        host=os.environ.get('FINANCE_EVAL_AGENT_RUNTIME_HOST' if agent else 'FINANCE_RUNTIME_HOST', '127.0.0.1'),
        port=int(os.environ.get('FINANCE_EVAL_AGENT_RUNTIME_PORT' if agent else 'FINANCE_RUNTIME_PORT', '56363' if agent else '56362')),
        access_log=False, timeout_graceful_shutdown=35, log_level='warning',
        log_config={'version': 1, 'disable_existing_loggers': False,
                    'formatters': {'safe': {'()': 'integrations.openjiuwen.operational_logging.SafeFormatter'}},
                    'handlers': {'safe': {'class': 'logging.StreamHandler', 'formatter': 'safe', 'stream': 'ext://sys.stderr'}},
                    'loggers': {'uvicorn': {'handlers': ['safe'], 'propagate': False, 'level': 'WARNING'},
                                'uvicorn.error': {'handlers': ['safe'], 'propagate': False, 'level': 'WARNING'}}}))
    start_stop_channel(lambda: setattr(server, 'should_exit', True))
    server.run()


if __name__ == '__main__':
    main()
