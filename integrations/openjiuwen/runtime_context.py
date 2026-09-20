"""Execution-local context and auth. SDK entrypoints come only from trusted worker config."""
import copy
import importlib
import inspect
import json
import os
import re


class RuntimeContext:
    def __init__(self, configuration=None, registry=None, environ=None):
        configuration = configuration or {}
        self.registry = registry or {}
        self.tools = configuration.get('tools', {})
        self.providers = configuration.get('providers', {})
        self.values = {}
        self.secrets = set()
        environ = os.environ if environ is None else environ
        for name, field in configuration.get('context', {}).items():
            if ('value' in field) == ('env' in field):
                raise ValueError('Context requires exactly one value source')
            if 'env' in field:
                if field['env'] not in environ:
                    raise ValueError(f'Missing context environment variable for {name}')
                raw = environ[field['env']]
                value = raw if field['type'] == 'string' else json.loads(raw)
            else:
                value = field['value']
            types = {'string': str, 'object': dict, 'array': list, 'number': (int, float), 'boolean': bool}
            expected = types.get(field.get('type'))
            if expected is None or not isinstance(value, expected) or (field['type'] == 'number' and isinstance(value, bool)):
                raise ValueError(f'Invalid context type for {name}')
            self.values[name] = copy.deepcopy(value)
            if field.get('sensitive', True):
                self.remember(value)
        for provider in self.providers.values():
            if provider['implementation'] not in ('bearer', 'headers') and provider['implementation'] not in self.registry:
                raise ValueError('Auth provider is not registered in the worker')
            for ref in provider.get('inputs', {}).values():
                self.resolve(ref)
        for binding in self.tools.values():
            if 'authBindings' in binding:
                raise ValueError('Script auth injection is not supported')
            for ref in binding.get('contextBindings', {}).values():
                self.resolve(ref)
            if binding.get('authProvider') and binding['authProvider'] not in self.providers:
                raise ValueError('Unknown auth provider')

    def remember(self, value):
        if isinstance(value, dict):
            for item in value.values(): self.remember(item)
        elif isinstance(value, list):
            for item in value: self.remember(item)
        elif value is not None:
            self.secrets.add(str(value))

    def resolve(self, reference):
        parts = reference.split('.')
        if parts[0] != 'context' or len(parts) < 2:
            raise ValueError('Invalid context reference')
        value = self.values
        for part in parts[1:]:
            if not isinstance(value, dict) or part not in value:
                raise ValueError(f'Missing context reference: {reference}')
            value = value[part]
        return copy.deepcopy(value)

    def context_headers(self, name):
        headers = {}
        for header, ref in self.tools.get(name, {}).get('contextBindings', {}).items():
            value = self.resolve(ref)
            text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=True, separators=(',', ':'))
            self.validate_header(header, text)
            if header.lower() in {key.lower() for key in headers}:
                raise ValueError('Duplicate context header')
            headers[header] = text
        return headers

    @staticmethod
    def validate_header(key, value):
        if not isinstance(key, str) or not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", key) or key.lower() in {'host','content-length','connection','transfer-encoding','content-type','accept','mcp-session-id','mcp-protocol-version'} or not isinstance(value, str) or re.search(r'[\r\n\x00]', value):
            raise ValueError('Invalid injected header')

    async def request_headers(self, name, base=None):
        context = self.context_headers(name)
        auth = await self.auth(name)
        if {key.lower() for key in context} & {key.lower() for key in auth}:
            raise ValueError('Context and auth header conflict')
        injected = {**context, **auth}
        replaced = {key.lower() for key in injected}
        return {**{key: value for key, value in (base or {}).items() if key.lower() not in replaced}, **injected}

    async def auth(self, name):
        provider_id = self.tools.get(name, {}).get('authProvider')
        if not provider_id: return {}
        provider = self.providers[provider_id]
        inputs = {key: self.resolve(ref) for key, ref in provider.get('inputs', {}).items()}
        self.remember(inputs)
        implementation = provider['implementation']
        if implementation == 'bearer':
            token = inputs.get('token')
            if not isinstance(token, str) or not token: raise ValueError('Bearer provider requires token')
            headers = {'Authorization': token if token.startswith('Bearer ') else 'Bearer ' + token}
        elif implementation == 'headers':
            headers = inputs.get('headers')
        else:
            module, function = self.registry[implementation]['entrypoint'].split(':', 1)
            try:
                result = getattr(importlib.import_module(module), function)(**inputs)
                headers = await result if inspect.isawaitable(result) else result
            except Exception:
                raise RuntimeError('Auth provider failed') from None
        if not isinstance(headers, dict): raise ValueError('Auth provider must return headers')
        if len({key.lower() for key in headers if isinstance(key, str)}) != len(headers):
            raise ValueError('Duplicate auth header')
        for key, value in headers.items():
            self.validate_header(key, value)
            self.remember(value)
        return headers
