import asyncio
import json
import sys
import types
import unittest
from unittest.mock import patch
from integrations.openjiuwen.runtime_context import RuntimeContext


def configuration(user='u1'):
    return {'context': {'user': {'type': 'object', 'value': {'id': user}},
                        'token': {'type': 'string', 'env': 'TEST_TOKEN'}},
            'providers': {'auth': {'implementation': 'bearer', 'inputs': {'token': 'context.token'}}},
            'tools': {'lookup': {'contextBindings': {'X-Business-User': 'context.user'}, 'authProvider': 'auth'}}}


class RuntimeContextTests(unittest.IsolatedAsyncioTestCase):
    async def test_context_is_in_headers_and_arguments_are_unmodified(self):
        runtime = RuntimeContext(configuration(), environ={'TEST_TOKEN': 'secret'})
        result = await runtime.request_headers('lookup')
        self.assertEqual(json.loads(result['X-Business-User']), {'id': 'u1'})
        self.assertEqual(result['Authorization'], 'Bearer secret')
        self.assertFalse(hasattr(runtime, 'arguments'))
        self.assertFalse(hasattr(runtime, 'script_arguments'))

    async def test_old_tool_has_no_injected_headers(self):
        self.assertEqual(await RuntimeContext().request_headers('old', {'Static': 'a'}), {'Static': 'a'})

    async def test_independent_executions_do_not_share_identity_or_credentials(self):
        first = RuntimeContext(configuration('first'), environ={'TEST_TOKEN': 'a'})
        second = RuntimeContext(configuration('second'), environ={'TEST_TOKEN': 'b'})
        a, b = await asyncio.gather(first.request_headers('lookup'), second.request_headers('lookup'))
        self.assertEqual((json.loads(a['X-Business-User'])['id'], a['Authorization']), ('first', 'Bearer a'))
        self.assertEqual((json.loads(b['X-Business-User'])['id'], b['Authorization']), ('second', 'Bearer b'))

    async def test_context_auth_conflict_and_legacy_script_binding_rejected(self):
        config = configuration()
        config['tools']['lookup']['contextBindings']['authorization'] = 'context.token'
        with self.assertRaises(ValueError):
            await RuntimeContext(config, environ={'TEST_TOKEN':'secret'}).request_headers('lookup')
        config = configuration()
        config['tools']['lookup']['authBindings'] = {'credential':'Authorization'}
        with self.assertRaises(ValueError): RuntimeContext(config, environ={'TEST_TOKEN':'secret'})

    async def test_static_header_override_is_case_insensitive(self):
        runtime = RuntimeContext(configuration(), environ={'TEST_TOKEN':'secret'})
        result = await runtime.request_headers('lookup', {'authorization':'old'})
        self.assertNotIn('authorization', result)
        self.assertEqual(result['Authorization'], 'Bearer secret')

    async def test_registered_sdk_receives_mapped_context(self):
        module = types.ModuleType('test_sdk')
        async def authenticate(userId): return {'Authorization': 'signed-' + userId}
        module.authenticate = authenticate
        config = configuration()
        config['providers']['auth'] = {'implementation': 'enterprise', 'inputs': {'userId': 'context.user.id'}}
        with patch.dict(sys.modules, {'test_sdk': module}):
            runtime = RuntimeContext(config, {'enterprise': {'entrypoint': 'test_sdk:authenticate'}}, {'TEST_TOKEN': 'secret'})
            self.assertEqual(await runtime.auth('lookup'), {'Authorization': 'signed-u1'})

    async def test_invalid_data_and_unregistered_provider_fail_before_execution(self):
        with self.assertRaises(ValueError): RuntimeContext(configuration(), environ={})
        config = configuration()
        config['context']['user'] = {'type': 'object', 'env': 'USER'}
        with self.assertRaises(ValueError): RuntimeContext(config, environ={'TEST_TOKEN': 'x', 'USER': '[]'})
        config = configuration()
        config['providers']['auth']['implementation'] = 'arbitrary.module'
        with self.assertRaises(ValueError): RuntimeContext(config, environ={'TEST_TOKEN': 'x'})

    async def test_header_injection_is_rejected(self):
        runtime = RuntimeContext(configuration(), environ={'TEST_TOKEN': 'bad\r\nheader'})
        with self.assertRaises(ValueError): await runtime.auth('lookup')


if __name__ == '__main__': unittest.main()
