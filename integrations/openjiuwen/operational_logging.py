"""Allowlisted operational events. Never copy SDK payloads or stderr to logs."""
import datetime
import json
import re
import sys
import os
import logging


class SafeFormatter(logging.Formatter):
    """Uvicorn errors must not expand request-bearing messages or tracebacks."""
    def format(self, record):
        return json.dumps({'time': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                           'component': 'runtime-server', 'event': 'server_log',
                           'level': record.levelname,
                           'errorType': record.exc_info[0].__name__ if record.exc_info else None})


def configure_sdk_logging():
    """Production SDK payloads go only to the bounded parent stderr drain."""
    if os.environ.get('NODE_ENV') != 'production':
        return
    from openjiuwen.core.common.logging.log_config import configure_log_config
    configure_log_config({'backend': 'default', 'level': 'WARNING',
                         'output': ['console'], 'interface_output': ['console'],
                         'performance_output': ['console']})


def event(name, **fields):
    allowed = {'runId', 'caseId', 'instanceId', 'pid', 'exitCode', 'elapsedMs',
               'terminal', 'stderrBytes', 'lastErrorType', 'timeoutMs', 'reason'}
    record = {'time': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'component': 'openjiuwen-worker', 'event': name}
    record.update({key: value for key, value in fields.items() if key in allowed})
    print(json.dumps(record, ensure_ascii=False), file=sys.stderr, flush=True)


async def drain_stderr(stream):
    """Bounded parsing retains size and exception class, not secret-bearing text."""
    count, tail, last_type = 0, b'', None
    while True:
        chunk = await stream.read(4096)
        if not chunk:
            break
        count += len(chunk)
        tail = (tail + chunk)[-8192:]
        matches = re.findall(rb'(?:^|\n)((?:[A-Za-z][A-Za-z0-9_]{0,70})?(?:Error|Exception)):', tail)
        if matches:
            last_type = matches[-1].decode('ascii')
    return {'stderrBytes': count, 'lastErrorType': last_type}


def timeout_ms(body):
    if not isinstance(body, dict) or not isinstance(body.get('limits') or {}, dict):
        raise ValueError('Invalid Runtime timeout')
    value = (body.get('limits') or {}).get('timeoutMs', 300000)
    if not isinstance(value, int) or isinstance(value, bool) or not 10000 <= value <= 900000:
        raise ValueError('Invalid Runtime timeout')
    return value
