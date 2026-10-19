import asyncio
from contextlib import redirect_stderr
import io
import json
import logging
import os
import unittest
from unittest.mock import patch
from integrations.openjiuwen.operational_logging import drain_stderr, event, timeout_ms, configure_sdk_logging, SafeFormatter


class LoggingTests(unittest.IsolatedAsyncioTestCase):
    async def test_bounded_drain_discards_raw_secrets(self):
        stream = asyncio.StreamReader()
        payload = b'x' * 200000 + b'\nValueError: bearer-secret-and-business-content\n'
        stream.feed_data(payload)
        stream.feed_eof()
        result = await drain_stderr(stream)
        self.assertEqual(result, {'stderrBytes': len(payload), 'lastErrorType': 'ValueError'})
        output = io.StringIO()
        with redirect_stderr(output):
            event('runtime_session_finished', **result, runId='run-1', apiKey='secret', body='private')
        self.assertNotIn('secret', output.getvalue())
        self.assertEqual(json.loads(output.getvalue())['runId'], 'run-1')

    def test_timeout_bounds(self):
        self.assertEqual(timeout_ms({}), 300000)
        self.assertEqual(timeout_ms({'limits': {'timeoutMs': 900000}}), 900000)
        for value in [True, 9999, 900001, '10000']:
            with self.assertRaises(ValueError):
                timeout_ms({'limits': {'timeoutMs': value}})

    def test_server_exception_does_not_emit_request_or_traceback(self):
        error = ValueError('private-error')
        record = logging.LogRecord('uvicorn.error', logging.ERROR, '', 1,
            'private-message %s', ('secret-token',), (ValueError, error, None))
        output = SafeFormatter().format(record)
        self.assertNotIn('private', output)
        self.assertNotIn('secret', output)
        self.assertEqual(json.loads(output)['errorType'], 'ValueError')

    def test_production_sdk_has_no_file_sinks(self):
        with patch.dict(os.environ, {'NODE_ENV': 'production'}):
            configure_sdk_logging()
        from openjiuwen.core.common.logging.log_config import get_log_config_snapshot
        config = get_log_config_snapshot()
        for key in ['output', 'interface_output', 'performance_output']:
            self.assertEqual(config[key], ['console'])


if __name__ == '__main__':
    unittest.main()
