"""Resolve operator-supplied tool inputs at the shared execution boundary."""
import os

from .environments import EnvironmentError


def runtime_inputs(configuration):
    public, secrets = {}, {}
    for name, value in configuration.get('runtimeInputs', {}).items():
        if 'secretEnv' in value:
            resolved = os.environ.get(value['secretEnv'], '')
            if not resolved.strip():
                raise EnvironmentError('请由环境维护者配置凭证引用：' + value['secretEnv'], 409)
            secrets['tool.env.' + name] = resolved
        elif value['value'].strip():
            public['tool.env.' + name] = value['value']
    return public, secrets
