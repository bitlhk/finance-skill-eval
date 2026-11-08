"""Existing fixed comparison HTTP endpoints and snapshot SSE stream."""
import asyncio
import json
from fastapi import Request
from fastapi.responses import Response, StreamingResponse
from evaluation.service import EvaluationRunService
from evaluation.reporting import html_report, markdown_report
from runtime.models import configured_model_role
from .identity import AccessError


async def service(request):
    workspace = request.state.workspace
    root = workspace['dataDirectory']
    async with request.app.state.run_service_lock:
        services = request.app.state.run_services
        if root not in services:
            factory = getattr(request.app.state, 'run_service_factory', EvaluationRunService)
            instance = factory(workspace)
            await instance.initialize()
            services[root] = instance
        return services[root]


def install_run_routes(app):
    @app.get('/api/runs')
    async def list_runs(request: Request):
        return {'runs': await (await service(request)).list(int(request.query_params.get('limit', '50')))}

    @app.post('/api/runs', status_code=202)
    async def create_run(request: Request):
        instance = await service(request)
        value = await request.json()
        if not request.state.workspace.get('publicDemo'):
            return await instance.create(value)
        from evaluation.configuration import run_configuration
        from storage.demo import DemoAccess
        value = run_configuration(value)
        if value.get('runtimeToolConfig') or value.get('runtimeBindings'):
            raise AccessError('CURATED_DEMO_ONLY')
        pack = await asyncio.to_thread(instance.catalog.get, value.get('packId'))
        runtime = await instance.environments.get(value['runtime']['environmentId']) if value['runtime']['type'] == 'runtime_launcher' else None
        if not pack or not pack['packId'].endswith('-online-v1') or not runtime or runtime['type'] not in ('runtime_launcher', 'execution_environment') or value.get('preparationId') or value.get('skillAssetId') or value['includeHoldout']:
            raise ValueError('请选择预制在线评测包与已配置环境。')
        assets = await instance.library.call('list')
        for variant in [value.get(side + 'Variant') for side in ('left', 'right')]:
            if variant and (variant['skillId'] != pack['targetSkillId'] or variant['mode'] == 'skill_version' and not any(asset['skillId'] == variant['skillId']
                    and asset['version'] == variant['version'] and (not variant.get('artifactSha256') or asset['artifactSha256'] == variant['artifactSha256']) for asset in assets)):
                raise ValueError('只能比较当前精选技能的已装配版本。')
        value.update(judgeMode='model', timeoutMs=310000, judgeModel=configured_model_role('JUDGE')['model'])
        return await DemoAccess(request.state.workspace['dataDirectory']).create(request.headers.get('x-demo-user'), instance, value)

    @app.get('/api/runs/{identifier}')
    async def get_run(identifier: str, request: Request):
        return await (await service(request)).get(identifier)

    @app.post('/api/runs/{identifier}/cancel')
    async def cancel(identifier: str, request: Request):
        if request.state.workspace.get('publicDemo'):
            from storage.demo import DemoAccess
            await DemoAccess(request.state.workspace['dataDirectory']).assert_owner(request.headers.get('x-demo-user'), identifier)
        return await (await service(request)).cancel(identifier)

    @app.post('/api/runs/{identifier}/retry', status_code=202)
    async def retry(identifier: str, request: Request):
        return await (await service(request)).retry(identifier)

    @app.post('/api/runs/{identifier}/rescore')
    async def rescore(identifier: str, request: Request):
        if request.state.workspace.get('publicDemo') or not request.state.workspace.get('accessToken'):
            raise AccessError('PRIVATE_WORKSPACE_REQUIRED')
        return await (await service(request)).rescore(identifier, await request.json())

    @app.post('/api/runs/{identifier}/rescore/start', status_code=202)
    async def start_rescore(identifier: str, request: Request):
        if request.state.workspace.get('publicDemo') or not request.state.workspace.get('accessToken'):
            raise AccessError('PRIVATE_WORKSPACE_REQUIRED')
        return await (await service(request)).start_rescore(identifier, await request.json())

    @app.get('/api/runs/{identifier}/events')
    async def events(identifier: str, request: Request):
        instance = await service(request)
        await instance.get(identifier)
        async def stream():
            previous, last_sent = '', 0
            while not instance.closing:
                value = await instance.get(identifier)
                stamp = value['updatedAt']
                timestamp = asyncio.get_running_loop().time()
                if stamp != previous:
                    previous, last_sent = stamp, timestamp
                    yield 'event: job\ndata: ' + json.dumps(value, ensure_ascii=False) + '\n\n'
                elif timestamp - last_sent > 15:
                    last_sent = timestamp
                    yield ': keepalive\n\n'
                await asyncio.sleep(.25)
        return StreamingResponse(stream(), media_type='text/event-stream', headers={'x-accel-buffering': 'no', 'cache-control': 'no-cache'})

    @app.get('/api/runs/{identifier}/export')
    async def export(identifier: str, request: Request):
        job = await (await service(request)).get(identifier)
        if not job.get('report'):
            raise FileNotFoundError('Evaluation report is unavailable')
        selected = request.query_params.get('format', 'json')
        if selected == 'html':
            return Response(html_report(job['report']), media_type='text/html')
        if selected == 'md':
            return Response(markdown_report(job['report']), media_type='text/markdown')
        return job['report']
