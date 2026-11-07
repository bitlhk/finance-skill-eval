"""Native public application. Controllers call Python capabilities directly."""
import asyncio
import base64
from datetime import datetime, timezone
import json
import logging
from pathlib import Path
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse, FileResponse, PlainTextResponse

from .configuration import load_configuration
from .identity import WorkspaceIdentity, AccessError
from .history_routes import install_history_routes
from .environment_routes import install_environment_routes
from .catalog_routes import install_catalog_routes
from .migration_routes import install_migration_routes
from .run_routes import install_run_routes
from .improvement_routes import install_improvement_routes
from .review_routes import install_review_routes
from .telemetry_routes import install_telemetry_routes
from storage.coordination import CoordinationConflict


class BodyLimit:
    def __init__(self, app, maximum=8 * 1024 * 1024):
        self.app, self.maximum = app, maximum

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        body = bytearray()
        while True:
            message = await receive()
            if message['type'] == 'http.disconnect':
                return
            if message['type'] != 'http.request':
                continue
            chunk = message.get('body', b'')
            if len(body) + len(chunk) > self.maximum:
                response = JSONResponse({'error': 'INVALID_REQUEST', 'message': 'Request body exceeds 8 MB'}, status_code=413)
                return await response(scope, receive, send)
            body.extend(chunk)
            if not message.get('more_body'):
                break
        delivered = False
        async def buffered_receive():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {'type': 'http.request', 'body': bytes(body), 'more_body': False}
            return await receive()
        await self.app(scope, buffered_receive, send)


def create_application(overrides=None):
    from integrations.openjiuwen.operational_logging import configure_sdk_logging
    configure_sdk_logging()
    config = load_configuration(overrides)
    identity = WorkspaceIdentity(config)
    @asynccontextmanager
    async def lifespan(app):
        yield
        await asyncio.gather(*(service.close() for service in app.state.improvement_services.values()), return_exceptions=True)
        await asyncio.gather(*(service.close() for service in [*app.state.migration_services.values(), *app.state.run_services.values()]), return_exceptions=True)
    app = FastAPI(lifespan=lifespan)
    app.state.migration_services = {}
    app.state.service_lock = asyncio.Lock()
    app.state.run_services = {}
    app.state.run_service_lock = asyncio.Lock()
    app.state.improvement_services = {}
    app.state.improvement_service_lock = asyncio.Lock()
    app.state.configuration, app.state.identity = config, identity
    logger = logging.getLogger('finance.api')

    @app.middleware('http')
    async def workspace(request: Request, call_next):
        request.state.request_id = str(uuid.uuid4())
        try:
            context = await identity.resolve(request.method, request.url.path, request.headers)
            request.state.workspace = context
            route = request.url.path
            if route.startswith('/api/migration-tasks') and (not context.get('accessToken') or context.get('publicDemo')):
                raise AccessError('PRIVATE_WORKSPACE_REQUIRED')
            import re
            from storage.history import HistoryStore
            historical = HistoryStore(context['dataDirectory'])
            task = re.match(r'^/api/migration-tasks/([a-z0-9-]+)(?:/|$)', route)
            environment = re.match(r'^/api/environments/([a-z0-9-]+)(?:/|$)', route)
            record = (await asyncio.to_thread(historical.blocked_task, task[1]) if task else
                      await asyncio.to_thread(historical.blocked_environment, environment[1]) if environment else None)
            if record:
                response = JSONResponse({'code': 'HISTORY_READ_ONLY', 'message': record['reason'],
                    'nextStep': record['nextStep'], 'historyUrl': f"/api/history/{record['origin']}/{record['id']}"}, status_code=409)
                response.headers['x-request-id'] = request.state.request_id
                response.headers['cache-control'] = 'no-store'
                return response
            if context.get('managedWorkspace') and request.method not in ('GET', 'HEAD', 'OPTIONS'):
                import re
                if route == '/api/environments' or re.fullmatch(r'/api/environments/[^/]+', route) or re.fullmatch(
                        r'/api/migrations/[^/]+/(check-business-connection|validate/technical)', route):
                    raise AccessError('MANAGED_CONFIGURATION_REQUIRED')
            if context.get('publicDemo') and route.startswith('/api/') and request.method != 'GET':
                import re
                import os
                if not re.fullmatch(r'studio_[a-zA-Z0-9_-]{1,80}', request.headers.get('x-demo-user', '')):
                    raise AccessError('AUTHENTICATED_ACCOUNT_REQUIRED', 401)
                if request.headers.get('origin') and request.headers['origin'] != os.environ.get('FINANCE_EVAL_PUBLIC_ORIGIN'):
                    raise AccessError('WORKSPACE_ORIGIN_REQUIRED')
                if request.method != 'POST' or not (route == '/api/runs' or re.fullmatch(
                        r'/api/runs/run-[a-z0-9-]+/cancel|/api/environments/env-[a-z0-9-]+/preflight', route)):
                    raise AccessError('CURATED_DEMO_ONLY')
            response = await call_next(request)
        except AccessError as error:
            response = JSONResponse({'error': error.code, **error.details}, status_code=error.status)
            if error.status == 429:
                response.headers['retry-after'] = str(error.details['retryAfterSeconds'])
        except ValueError as error:
            response = JSONResponse({'error': 'INVALID_REQUEST', 'message': str(error)}, status_code=getattr(error, 'status', 400))
        response.headers['x-request-id'] = request.state.request_id
        if request.url.path.startswith('/api/'):
            response.headers['cache-control'] = 'no-store'
        return response

    @app.exception_handler(HTTPException)
    async def http_error(_request, error):
        return JSONResponse({'error': 'INVALID_REQUEST', 'message': str(error.detail)}, status_code=error.status_code)

    @app.exception_handler(ValueError)
    async def invalid(_request, error):
        return JSONResponse({'error': 'INVALID_REQUEST', 'message': str(error)}, status_code=getattr(error, 'status', 400))

    @app.exception_handler(FileNotFoundError)
    async def missing(_request, _error):
        return JSONResponse({'error': 'NOT_FOUND'}, status_code=404)

    @app.exception_handler(CoordinationConflict)
    async def conflict(_request, error):
        return JSONResponse({'error': 'CONFLICT', 'message': str(error)}, status_code=409)

    @app.exception_handler(Exception)
    async def unexpected(request, error):
        logger.error('request_failed', extra={'requestId': getattr(request.state, 'request_id', None),
                     'errorType': type(error).__name__})
        return JSONResponse({'error': 'SERVICE_ERROR', 'requestId': getattr(request.state, 'request_id', None)}, status_code=500)

    @app.get('/api/health')
    async def health():
        return {'status': 'ready', 'service': 'finance-skill-eval',
                'deploymentMode': 'curated-public-demo' if config['publicDemo'] else 'local-workspace',
                'version': '0.5.1', 'time': datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')}

    async def upload(request, migration=False):
        from assets.store import execute
        if request.headers.get('content-type', '').split(';')[0].lower() not in (
                'application/zip', 'application/x-zip-compressed', 'application/octet-stream'):
            raise HTTPException(400, 'Request body must be a Skill ZIP')
        body = await request.body()
        context = request.state.workspace
        def save():
            execute({'root': context['dataDirectory'], 'action': 'initialize'})
            return execute({'root': context['dataDirectory'], 'action': 'upload',
                'archive': base64.b64encode(body).decode('ascii'), 'migrationInput': migration,
                'legacyOrderIndex': context['legacyOrderIndex']})
        return await asyncio.to_thread(save)

    @app.post('/api/skills/upload')
    async def upload_skill(request: Request):
        return await upload(request)

    @app.post('/api/migration-tasks/assets')
    async def upload_migration_source(request: Request):
        return await upload(request, True)

    install_history_routes(app)
    install_environment_routes(app)
    install_catalog_routes(app)
    install_migration_routes(app)
    install_run_routes(app)
    install_improvement_routes(app)
    install_review_routes(app)
    install_telemetry_routes(app)

    @app.get('/{asset_path:path}')
    async def web(asset_path: str):
        if asset_path.startswith('api/'):
            return JSONResponse({'error': 'NOT_FOUND', 'message': 'API route not found'}, status_code=404)
        root = Path(config['publicDirectory']).resolve()
        file = (root / asset_path).resolve()
        if file.is_relative_to(root) and file.is_file() and not any(part.startswith('.') for part in Path(asset_path).parts):
            return FileResponse(file)
        if asset_path.startswith('assets/'):
            return JSONResponse({'error': 'NOT_FOUND', 'message': 'Asset not found; reload the page'}, status_code=404)
        if (root / 'index.html').is_file():
            return FileResponse(root / 'index.html')
        return PlainTextResponse('Finance Skill Eval service is ready. Build the web console with pnpm build:web.')

    app.add_middleware(BodyLimit)
    return app
