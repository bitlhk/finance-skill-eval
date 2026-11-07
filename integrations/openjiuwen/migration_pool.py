"""Bind migration instances to Jiuwen Runtime's session service manager."""
import os
import socket
import sys
from types import SimpleNamespace
import httpx

from openjiuwen_runtime.management.session import (
    Access, AccessConfig, IResponseParser, IServiceInstanceFactory,
    PriorityDualAsyncQueues, ServiceHandler, ServiceManager, SessionConfig,
    SessionRequest, Timer, WSServiceMessageChannel,
)
from openjiuwen_runtime.management.session.process_service_handler import (
    ProcessDeployController, ProcessServiceHandler,
)


class _Parser(IResponseParser):
    def request_id(self, data):
        return data.get('request_id')

    def is_completed(self, data):
        return data.get('completed') is True

    def response(self, data):
        return data


class _ProcessController(ProcessDeployController):
    async def deploy(self):
        info = await super().deploy()
        # The SDK service manager logs pod_name even for process deployments.
        # Preserve the process endpoint and adapt only that metadata shape.
        return SimpleNamespace(host=info.host, port=info.port, pod_name=f'process-{info.process_id}')


def _available_port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


class _Factory(IServiceInstanceFactory):
    async def new_service(self, response_parser, service_template=None):
        port = _available_port()
        names = ('FINANCE_EVAL_DATA_DIR', 'FINANCE_RUNTIME_CONFIG', 'FINANCE_EVAL_ACCESS_TOKEN',
                 'FINANCE_EVAL_AGENT_ROLE_VERSION', 'PYTHONUTF8', 'PYTHONUNBUFFERED', 'AGENT_SERVER_LOG_FILE',
                 'FINANCE_EVAL_PROJECT_EXECUTION_IMAGE', 'FINANCE_EVAL_DOCKER_WSL_DISTRIBUTION', 'FINANCE_EVAL_DOCKER_WSL_USER',
                 'USERPROFILE', 'NODE_ENV', 'TMPDIR', 'OPENJIUWEN_RUNTIME_LOG_CONFIG',
                 'OPENJIUWEN_RUNTIME_LOG_FILE', 'OPENJIUWEN_RUNTIME_LOG_DIR')
        env = {key: os.environ[key] for key in names if key in os.environ}
        # Role execution is native in the instance. Forward the operator's
        # model configuration via its process environment, never task payloads
        # or the execution journal. Uploaded projects cannot supply these keys.
        model_names = {'FINANCE_EVAL_MODEL', 'FINANCE_EVAL_MODEL_BASE_URL', 'FINANCE_EVAL_MODEL_API_KEY',
                       'FINANCE_EVAL_MODEL_AUTH_MODE', 'FINANCE_EVAL_CODEX_BIN', 'FINANCE_EVAL_MODEL_MAX_RETRIES'}
        model_names.update(f'FINANCE_EVAL_{role}_{field}'
                           for role in ('JUDGE', 'OPTIMIZER', 'MIGRATION', 'EXECUTION', 'ANALYZER')
                           for field in ('MODEL', 'BASE_URL', 'API_KEY', 'AUTH_MODE', 'PROVIDER', 'REQUEST_DEFAULTS', 'NATIVE_TOOLS', 'TIMEOUT_MS'))
        env.update({key: os.environ[key] for key in model_names if key in os.environ})
        token = env.get('FINANCE_EVAL_ACCESS_TOKEN', '').strip()
        channel = WSServiceMessageChannel(target_port=port, invoke_path='/invoke',
                    additional_headers={'Authorization': 'Bearer ' + token} if token else None)
        process = ProcessServiceHandler(publish_port=port, env_vars=env,
                    python_executable=sys.executable, module='integrations.openjiuwen.migration_instance')
        return ServiceHandler(total_concurrency=1, message_channel=channel,
                              response_parser=response_parser,
                              deploy_controller=_ProcessController(process),
                              service_template=service_template)


class MigrationPool:
    def __init__(self, max_services=4, min_idle=0, session_ttl=300, service_ttl=300):
        self.config = AccessConfig(service_concurrency=1, min_idle_services=min_idle,
                                   max_services=max_services, service_ttl=service_ttl)
        self.session_ttl = session_ttl
        self.access = Access(self._create_manager)

    async def _create_manager(self):
        self.manager = ServiceManager(service_factory=_Factory(), dual_queue=PriorityDualAsyncQueues(100, 1000),
            timer=Timer(), service_concurrency=1, min_idle_services=self.config.min_idle_services,
            max_services=self.config.max_services, service_idle_ttl=self.config.service_ttl,
            deploy_mode='process', pod_monitor_enabled=False)
        return self.manager

    async def start(self):
        await self.access.init(response_parser=_Parser(), config=self.config,
                               session_config=SessionConfig(concurrency=1, ttl=self.session_ttl))

    async def stop(self):
        await self.access.shutdown()

    async def stream(self, session_id, request_id, payload):
        raw = {'session_id': session_id, 'request_id': request_id, 'payload': payload}
        request = SessionRequest(session_id=session_id, concurrency=1, ttl=self.session_ttl,
                                 request_id=request_id, raw=raw)
        async for frame in self.access.send_message(request):
            yield frame

    async def _endpoint(self, session_id):
        # Runtime's current public API does not expose its session route.
        # Keep the version-specific access confined to this adapter.
        service_id = await self.manager._service_router.get_session_service(session_id)
        for services in self.manager._in_use.values():
            service = services.get(service_id)
            if service and service.pod_info:
                return f'http://127.0.0.1:{service.pod_info.port}'
        return None

    async def control(self, session_id, attempt_id, request_id=None, text=None):
        from urllib.parse import quote
        endpoint = await self._endpoint(session_id)
        if not endpoint:
            return False
        token = os.environ.get('FINANCE_EVAL_ACCESS_TOKEN', '').strip()
        headers = {'Authorization': 'Bearer ' + token} if token else {}
        async with httpx.AsyncClient(timeout=15, headers=headers, trust_env=False) as client:
            try:
                if request_id is None:
                    response = await client.get(f'{endpoint}/ready/{quote(session_id, safe="")}/{quote(attempt_id, safe="")}')
                    return response.is_success and response.json().get('ready') is True
                response = await client.post(f'{endpoint}/instruction/{quote(session_id, safe="")}',
                    json={'attemptId': attempt_id, 'requestId': request_id, 'text': text})
                return response.is_success
            except httpx.HTTPError:
                return False

    async def cancel(self, session_id, attempt_id):
        from urllib.parse import quote
        endpoint = await self._endpoint(session_id)
        if not endpoint:
            return False
        token = os.environ.get('FINANCE_EVAL_ACCESS_TOKEN', '').strip()
        headers = {'Authorization': 'Bearer ' + token} if token else {}
        async with httpx.AsyncClient(timeout=15, headers=headers, trust_env=False) as client:
            try:
                result = await client.post(f'{endpoint}/cancel/{quote(session_id, safe="")}/{quote(attempt_id, safe="")}')
                return result.is_success
            except httpx.HTTPError:
                return False

    async def transition(self, session_id, attempt_id, action, instructions=()):
        if action not in ('pause', 'resume'):
            raise ValueError('Invalid session control')
        from urllib.parse import quote
        endpoint = await self._endpoint(session_id)
        if not endpoint:
            return False
        token = os.environ.get('FINANCE_EVAL_ACCESS_TOKEN', '').strip()
        headers = {'Authorization': 'Bearer ' + token} if token else {}
        async with httpx.AsyncClient(timeout=120, headers=headers, trust_env=False) as client:
            try:
                result = await client.post(f'{endpoint}/{action}/{quote(session_id, safe="")}/{quote(attempt_id, safe="")}', json={'instructions':list(instructions)})
                return result.is_success
            except httpx.HTTPError:
                return False

    async def control_state(self, session_id, attempt_id):
        from urllib.parse import quote
        endpoint = await self._endpoint(session_id)
        if not endpoint:
            return 'UNAVAILABLE'
        token = os.environ.get('FINANCE_EVAL_ACCESS_TOKEN', '').strip()
        headers = {'Authorization': 'Bearer ' + token} if token else {}
        async with httpx.AsyncClient(timeout=5, headers=headers, trust_env=False) as client:
            try:
                result = await client.get(f'{endpoint}/control-state/{quote(session_id, safe="")}/{quote(attempt_id, safe="")}')
                state = result.json().get('state') if result.is_success else None
                return state if state in ('RUNNING', 'PAUSING', 'PAUSED', 'IDLE') else 'UNAVAILABLE'
            except (httpx.HTTPError, ValueError):
                return 'UNAVAILABLE'
