"""Model I/O for application roles; no Agent loop or workspace access policy here."""
import asyncio
import json
import os
import shutil
from copy import deepcopy



class ModelCompletionError(RuntimeError):
    def __init__(self, code, message, http_status=None):
        super().__init__(message)
        self.code, self.http_status = code, http_status


def model_failure(error):
    """Project SDK/provider failures without exposing prompts or credentials."""
    if isinstance(error, ModelCompletionError):
        return error
    current, visited = error, set()
    while isinstance(current, BaseException) and id(current) not in visited:
        visited.add(id(current))
        status = getattr(current, 'status_code', None)
        if type(status) is int and 100 <= status <= 599:
            guidance = '；请检查模型服务账户状态和可用额度后重试' if status == 402 else ''
            return ModelCompletionError('MODEL_HTTP_ERROR', f'模型服务请求失败（HTTP {status}）{guidance}', status)
        current = current.__cause__ or current.__context__
    return ModelCompletionError('MODEL_NETWORK_ERROR', '模型调用失败或超时，请检查服务配置与连接')


def model_timeout_ms(role):
    raw = os.environ.get(f'FINANCE_EVAL_{role}_TIMEOUT_MS', '')
    try:
        value = int(raw)
        if value > 0:
            return value
    except ValueError:
        pass
    return {'JUDGE': 240000, 'ANALYZER': 600000, 'MIGRATION': 300000}.get(role, 180000)


class OpenJiuwenModel:
    """Application completion contract over the same SDK model used by Agents."""
    def __init__(self, options):
        self.options = deepcopy(options)
        self.adapter_id = options.get('adapterId', 'openjiuwen-model-v1')
        self.supports_tools = options.get('supportsTools', True)

    async def complete(self, request):
        from integrations.openjiuwen.model_config import create_model
        options = self.options
        # The caller owns the explicit request; provider defaults cannot replace
        # its messages/model or reintroduce tools in a tool-free evaluation.
        params = {**deepcopy(options.get('requestDefaults', {})),
                  **deepcopy(request['model'].get('parameters', {}))}
        for key in ('messages', 'model', 'stream', 'api_key', 'base_url', 'headers', 'timeout'):
            params.pop(key, None)
        if request.get('toolFree') or not self.supports_tools:
            for key in ('tools', 'tool_choice', 'functions', 'function_call', 'parallel_tool_calls'):
                params.pop(key, None)
            extra = params.get('extra_body')
            if isinstance(extra, dict):
                for key in ('tools', 'tool_choice', 'functions', 'function_call', 'parallel_tool_calls'):
                    extra.pop(key, None)
        elif request.get('tools'):
            params['tools'] = deepcopy(request['tools'])
        if request.get('responseFormat') == 'json':
            params['response_format'] = {'type': 'json_object'}
        limit = params.get('max_completion_tokens', params.get('max_tokens'))
        model = create_model(options, {'model_name': request['model']['modelId']},
                             role=options.get('role', 'EXECUTION'),
                             timeout_ms=options.get('timeoutMs', 180000),
                             temperature=params.pop('temperature', 0.2),
                             max_tokens=params.pop('max_tokens', None), defaults={})
        try:
            response = await model.invoke(request['messages'], **params)
        except Exception as error:
            raise model_failure(error) from error
        if response.finish_reason == 'length':
            used = getattr(response.usage_metadata, 'output_tokens', None)
            details = ([f'已用输出 token：{used}'] if type(used) is int and used >= 0 else [])
            details.append(f'请求输出上限：{limit}' if type(limit) is int and limit >= 0 else '请求未显式配置输出上限')
            raise ModelCompletionError('MODEL_OUTPUT_TRUNCATED', '模型输出达到长度上限，未形成完整结果（' + '；'.join(details) + '）；请检查模型输出预算')
        content, calls = response.content, response.tool_calls
        if (not isinstance(content, str) or not content.strip()) and not calls:
            raise ModelCompletionError('MODEL_EMPTY_RESPONSE', '模型没有返回最终答案')
        result = {'content': content or '', 'modelId': request['model']['modelId']}
        if calls:
            result['toolCalls'] = [{'id': call.id, 'type': call.type,
                                   'function': {'name': call.name, 'arguments': call.arguments}} for call in calls]
        usage = response.usage_metadata
        if usage is not None:
            result['modelId'] = usage.model_name or result['modelId']
            result['usage'] = {'inputTokens': usage.input_tokens, 'outputTokens': usage.output_tokens,
                               'totalTokens': usage.total_tokens}
        return result

def parse_codex_output(output):
    events = []
    for line in output.splitlines():
        try:
            event = json.loads(line)
            if isinstance(event, dict):
                events.append(event)
        except ValueError:
            pass
    messages = [event['item'].get('text') for event in events if event.get('type') == 'item.completed'
                and (event.get('item') or {}).get('type') == 'agent_message' and event['item'].get('text')]
    if not messages:
        raise ModelCompletionError('MODEL_EMPTY_RESPONSE', 'Codex Judge returned no final message')
    result = {'content': messages[-1]}
    last = next((event for event in reversed(events) if event.get('type') == 'turn.completed'), {})
    usage = last.get('usage')
    if usage:
        result['usage'] = {'inputTokens': usage.get('input_tokens', 0), 'outputTokens': usage.get('output_tokens', 0),
                           'totalTokens': usage.get('input_tokens', 0) + usage.get('output_tokens', 0)}
    return result


def configured_model_role(role, fallback_model='glm-5.2'):
    if role not in ('ANALYZER', 'EXECUTION', 'JUDGE', 'OPTIMIZER', 'MIGRATION'):
        raise ValueError('Unknown model role')
    env = os.environ
    if role in ('JUDGE', 'OPTIMIZER', 'MIGRATION') and env.get(f'FINANCE_EVAL_{role}_PROVIDER', '').strip().lower() == 'codex_cli':
        executable = shutil.which(env.get('FINANCE_EVAL_CODEX_BIN', 'codex').strip())
        model = {'providerId': 'codex-host', 'modelId': env.get(f'FINANCE_EVAL_{role}_MODEL', '').strip() or 'gpt-6-astra',
                 'label': {'JUDGE': 'Codex 匿名 Judge', 'MIGRATION': 'Codex 代码迁移模型', 'OPTIMIZER': 'Codex Skill 优化模型'}[role], 'parameters': {}}
        return {'configured': bool(executable), 'model': model, 'adapter': CodexCLIModel({'executable': executable}) if executable else None}
    value = lambda name, default='': env.get(f'FINANCE_EVAL_{role}_{name}', env.get('FINANCE_EVAL_MODEL_' + name, default))
    model_id = env.get(f'FINANCE_EVAL_{role}_MODEL', env.get('FINANCE_EVAL_MODEL', fallback_model))
    base, key = value('BASE_URL'), value('API_KEY')
    defaults = json.loads(env.get(f'FINANCE_EVAL_{role}_REQUEST_DEFAULTS', '{}'))
    if not isinstance(defaults, dict):
        raise ValueError('Model request defaults must be an object')
    model = {'providerId': 'service-' + role.lower(), 'modelId': model_id, 'parameters': {},
             'label': {'ANALYZER': '出题', 'EXECUTION': '执行', 'MIGRATION': '代码迁移', 'OPTIMIZER': '优化', 'JUDGE': '阅卷'}[role] + '模型'}
    configured = bool(base.strip() and key.strip())
    adapter = OpenJiuwenModel({'adapterId': 'service-' + role.lower() + '-openai-compatible-v1',
        'apiKey': key, 'baseUrl': base, 'authMode': value('AUTH_MODE', 'bearer'), 'requestDefaults': defaults,
        'supportsTools': env.get(f'FINANCE_EVAL_{role}_NATIVE_TOOLS', '').strip().lower() != 'false',
        'timeoutMs': model_timeout_ms(role), 'role': role}) if configured else None
    return {'configured': configured, 'model': model, 'adapter': adapter}


def agent_role_binding(role, reference=None):
    configured = configured_model_role(role)
    expected = configured['model']
    if not configured['configured'] or reference is not None and any(reference.get(key) != expected[key] for key in ('providerId', 'modelId')):
        raise ValueError('Requested role model is not configured in this service')
    if expected['providerId'] == 'codex-host':
        from .codex_provider import register_codex_provider
        register_codex_provider()
        bound = {'sdkProvider': 'FinanceCodex', 'apiKey': 'host-auth', 'baseUrl': 'http://localhost'}
    else:
        bound = configured['adapter'].options
    return bound, expected


class CodexCLIModel:
    supports_tools = False

    def __init__(self, options=None):
        self.options = options or {}
        self.adapter_id = self.options.get('adapterId', 'codex-cli-model-v1')

    async def complete(self, request):
        # Reuse the existing process-tree termination. No shell command is
        # built from model/user text.
        from integrations.openjiuwen.session_process import terminate_tree
        prompt = '\n\n'.join([
            'You are a stateless model completing the role specified in the following system message.',
            'Do not call tools, inspect files, or modify the workspace.',
            'Return only the JSON object requested by the messages, with no markdown fence.' if request.get('responseFormat') == 'json' else 'Return only the requested answer.',
            '', *('[' + message['role'].upper() + ']\n' + message.get('content', '') for message in request['messages'])])
        args = [self.options.get('executable') or 'codex', '--ask-for-approval', 'never', 'exec', '--ephemeral',
                '--skip-git-repo-check', '--ignore-rules', '--ignore-user-config', '--sandbox', 'read-only',
                '--model', request['model']['modelId'], '--json', '-']
        process = await asyncio.create_subprocess_exec(*args, cwd=self.options.get('cwd'),
            start_new_session=os.name != 'nt', stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            **({'creationflags': 0x08000000} if os.name == 'nt' else {}))
        try:
            async with asyncio.timeout(self.options.get('timeoutMs', 300000) / 1000):
                stdout, stderr = await process.communicate(prompt.encode('utf-8'))
            if process.returncode:
                raise ModelCompletionError('MODEL_CLI_ERROR', f'Codex Judge exited with code {process.returncode}')
            return {**parse_codex_output(stdout.decode('utf-8')), 'modelId': request['model']['modelId'],
                    'metadata': {'authMode': 'codex-host', 'ephemeral': True}}
        finally:
            if process.returncode is None:
                await terminate_tree(process)
