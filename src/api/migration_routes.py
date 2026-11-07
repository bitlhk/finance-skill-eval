"""The existing Skill migration HTTP API over one native application service."""
import asyncio
import json
from pathlib import Path

from fastapi import Request, HTTPException
from fastapi.responses import StreamingResponse, Response
import yaml

from migration.service import MigrationTaskService


async def service(request):
    context = request.state.workspace
    root = context['dataDirectory']
    async with request.app.state.service_lock:
        services = request.app.state.migration_services
        if root not in services:
            factory = getattr(request.app.state, 'migration_service_factory', MigrationTaskService)
            instance = factory(context)
            await instance.initialize()
            services[root] = instance
        return services[root]


def install_migration_routes(app):
    @app.get('/api/migration-tasks/suite-example')
    async def example():
        return json.loads((Path(__file__).parents[2] / 'contracts/platform/suite-example.json').read_text(encoding='utf-8'))

    @app.get('/api/migration-tasks')
    async def list_tasks(request: Request):
        return await (await service(request)).list()

    @app.post('/api/migration-tasks')
    async def create_task(request: Request):
        return await (await service(request)).create(await request.json(), request.state.request_id)

    @app.post('/api/migration-tasks/upload')
    async def upload_task(request: Request):
        if request.headers.get('content-type', '').split(';')[0].lower() not in ('application/zip', 'application/x-zip-compressed', 'application/octet-stream'):
            raise HTTPException(400, '请上传包含所选 Skill 及可选依赖的 ZIP')
        value = dict(request.query_params)
        if 'configuration' in value:
            value['configuration'] = json.loads(value['configuration'])
        return await (await service(request)).create(value, request.state.request_id, archive=await request.body())

    @app.get('/api/migration-tasks/{identifier}')
    async def get_task(identifier: str, request: Request):
        return await (await service(request)).get(identifier)

    @app.get('/api/migration-tasks/{identifier}/conversation')
    async def conversation(identifier: str, request: Request):
        if set(request.query_params) - {'after', 'limit'}:
            raise ValueError('Invalid conversation cursor')
        return await (await service(request)).conversation(identifier, int(request.query_params.get('after', '0')), int(request.query_params.get('limit', '100')))

    @app.post('/api/migration-tasks/{identifier}/conversation/answer', status_code=202)
    async def answer(identifier: str, request: Request):
        return await (await service(request)).answer(identifier, await request.json(), request.state.request_id)

    @app.post('/api/migration-tasks/{identifier}/conversation/message', status_code=202)
    async def message(identifier: str, request: Request):
        return await (await service(request)).message(identifier, await request.json(), request.state.request_id)

    @app.post('/api/migration-tasks/{identifier}/conversation/optimization/resume', status_code=202)
    async def resume_budget(identifier: str, request: Request):
        return await (await service(request)).resume_optimization(identifier, await request.json(), request.state.request_id)

    @app.post('/api/migration-tasks/{identifier}/conversation/control/{action}')
    async def control(identifier: str, action: str, request: Request):
        return await (await service(request)).control_conversation(identifier, action)

    @app.get('/api/migration-tasks/{identifier}/conversation/control')
    async def reconcile(identifier: str, request: Request):
        return await (await service(request)).reconcile_control(identifier)

    @app.put('/api/migration-tasks/{identifier}/configuration')
    async def configuration(identifier: str, request: Request):
        return await (await service(request)).configure(identifier, await request.json())

    @app.put('/api/migration-tasks/{identifier}/baseline-configuration')
    async def baseline_configuration(identifier: str, request: Request):
        return await (await service(request)).configure(identifier, await request.json(), 'baseline')

    @app.put('/api/migration-tasks/{identifier}/suite')
    async def suite(identifier: str, request: Request):
        return await (await service(request)).save_suite(identifier, await request.json())

    @app.post('/api/migration-tasks/{identifier}/plan/approval')
    async def approve(identifier: str, request: Request):
        return await (await service(request)).approve_plan(identifier, await request.json())

    @app.post('/api/migration-tasks/{identifier}/runtime-review')
    async def review_runtime(identifier: str, request: Request):
        return await (await service(request)).review_runtime(identifier)

    @app.post('/api/migration-tasks/{identifier}/runtime-check')
    async def check_runtime(identifier: str, request: Request):
        return await (await service(request)).check_runtime(identifier)

    @app.post('/api/migration-tasks/{identifier}/runtime-build-requests')
    async def build_request(identifier: str, request: Request):
        instance = await service(request)
        await instance.builder.request(identifier, await request.json())
        return await instance.get(identifier)

    @app.get('/api/migration-tasks/{identifier}/runtime-requirements.yaml')
    async def build_requirements(identifier: str, request: Request):
        if set(request.query_params) - {'requestId'}:
            raise ValueError('Invalid Builder requirements query')
        value = await (await service(request)).builder.requirements(identifier, request.query_params.get('requestId'))
        return Response(yaml.safe_dump(value, allow_unicode=True, sort_keys=False), media_type='application/yaml',
            headers={'content-disposition': 'attachment; filename="runtime-build-requirements.yaml"'})

    @app.post('/api/migration-tasks/{identifier}/runtime-deliveries')
    async def delivery(identifier: str, request: Request):
        instance = await service(request)
        await instance.builder.accept(identifier, await request.json())
        return await instance.get(identifier)

    @app.post('/api/migration-tasks/{identifier}/runtime-build/start', status_code=202)
    async def start_builder(identifier: str, request: Request):
        return await (await service(request)).builder.start(identifier, await request.json())

    @app.delete('/api/migration-tasks/{identifier}/runtime-builder-selection')
    async def existing_runtime(identifier: str, request: Request):
        instance = await service(request)
        await instance.builder.use_existing(identifier)
        return await instance.get(identifier)

    for route, kind in (('baseline', 'BASELINE'), ('acceptance', 'ACCEPT'), ('optimize', 'OPTIMIZE')):
        def operation(kind):
            async def start(identifier: str, request: Request):
                return await (await service(request)).start(identifier, kind, await request.json(), request.state.request_id)
            return start
        app.add_api_route('/api/migration-tasks/{identifier}/' + route, operation(kind), methods=['POST'], status_code=202)

    @app.post('/api/migration-tasks/{identifier}/cancel')
    async def cancel(identifier: str, request: Request):
        return await (await service(request)).cancel(identifier)

    @app.post('/api/migration-tasks/{identifier}/optimization-selection')
    async def select(identifier: str, request: Request):
        return await (await service(request)).select_optimization(identifier, await request.json())

    @app.post('/api/migration-tasks/{identifier}/rescore')
    async def rescore(identifier: str, request: Request):
        return await (await service(request)).rescore(identifier, await request.json())

    @app.post('/api/migration-tasks/{identifier}/rescore/start', status_code=202)
    async def start_rescore(identifier: str, request: Request):
        return await (await service(request)).start_rescore(identifier, await request.json())

    @app.post('/api/migration-tasks/{identifier}/analyze-run')
    async def analyze(identifier: str, request: Request):
        return await (await service(request)).analyze_run(identifier, await request.json())

    @app.get('/api/migration-tasks/{identifier}/file')
    async def file(identifier: str, request: Request):
        if set(request.query_params) - {'candidateId', 'path'} or 'path' not in request.query_params:
            raise ValueError('Invalid file query')
        return await (await service(request)).file(identifier, request.query_params.get('candidateId'), request.query_params['path'])

    @app.get('/api/migration-tasks/{identifier}/activity')
    async def activity(identifier: str, request: Request):
        instance = await service(request)
        await instance.repository.get(identifier)
        return await instance.activity_store.get(identifier)

    @app.get('/api/migration-tasks/{identifier}/export')
    async def export(identifier: str, request: Request):
        from migration.export import export_task
        if set(request.query_params) - {'verified', 'basic'} or any(value not in ('true', 'false') for value in request.query_params.values()):
            raise ValueError('Invalid export options')
        archive = await export_task(await service(request), identifier, request.query_params.get('verified') == 'true', request.query_params.get('basic') == 'true')
        return Response(archive, media_type='application/zip', headers={'content-disposition': 'attachment; filename="migration-bundle.zip"'})

    @app.get('/api/migration-tasks/{identifier}/optimization-workspace')
    async def workspace(identifier: str, request: Request):
        from migration.export import optimization_workspace
        if set(request.query_params) != {'attemptId'}:
            raise ValueError('Invalid optimization workspace query')
        archive = await optimization_workspace(await service(request), identifier, request.query_params['attemptId'])
        return Response(archive, media_type='application/zip', headers={'content-disposition': 'attachment; filename="optimization-project.zip"'})

    @app.get('/api/migration-tasks/{identifier}/activity/events')
    async def events(identifier: str, request: Request):
        instance = await service(request)
        await instance.repository.get(identifier)
        async def stream():
            revision, last_sent = '', 0
            while not instance.closing:
                value = await instance.activity_store.get(identifier)
                identity = f"{value['taskId']}:{value['updatedAt']}:{value['status']}" if value else 'empty'
                timestamp = asyncio.get_running_loop().time()
                if identity != revision:
                    revision, last_sent = identity, timestamp
                    yield 'data: ' + json.dumps(value, ensure_ascii=False) + '\n\n'
                elif timestamp - last_sent > 5:
                    last_sent = timestamp
                    yield ': heartbeat\n\n'
                await asyncio.sleep(0.35)
        return StreamingResponse(stream(), media_type='text/event-stream', headers={'X-Accel-Buffering': 'no', 'Cache-Control': 'no-cache'})
