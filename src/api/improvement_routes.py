"""Optimization endpoints sharing the native comparison service."""
import asyncio
from fastapi import Request
from improvement.service import OptimizationService
from .identity import AccessError
from .run_routes import service as run_service


async def service(request):
    context = request.state.workspace
    if context.get('publicDemo') or not context.get('accessToken'):
        raise AccessError('PRIVATE_WORKSPACE_REQUIRED')
    runs = await run_service(request)
    async with request.app.state.improvement_service_lock:
        services = request.app.state.improvement_services
        root = context['dataDirectory']
        if root not in services:
            factory = getattr(request.app.state, 'improvement_service_factory', OptimizationService)
            services[root] = factory(context, runs)
        return services[root]


def install_improvement_routes(app):
    @app.post('/api/runs/{identifier}/optimize', status_code=202)
    async def optimize(identifier: str, request: Request):
        return await (await service(request)).create(identifier, await request.json())

    @app.get('/api/runs/{identifier}/optimization')
    async def for_source(identifier: str, request: Request):
        return await (await service(request)).for_source(identifier)

    @app.get('/api/optimizations/{identifier}')
    async def get(identifier: str, request: Request):
        return await (await service(request)).get(identifier)

    @app.post('/api/optimizations/{identifier}/answer', status_code=202)
    async def answer(identifier: str, request: Request):
        return await (await service(request)).answer(identifier, await request.json())

    @app.post('/api/optimizations/{identifier}/recover', status_code=202)
    async def recover(identifier: str, request: Request):
        return await (await service(request)).answer(identifier, None, recover=True)

    @app.post('/api/optimizations/{identifier}/reevaluate', status_code=202)
    async def reevaluate(identifier: str, request: Request):
        return await (await service(request)).reevaluate(identifier)

    @app.post('/api/optimizations/{identifier}/final-verify', status_code=202)
    async def verify(identifier: str, request: Request):
        return await (await service(request)).reevaluate(identifier, final=True)

    @app.post('/api/optimizations/{identifier}/decision')
    async def decide(identifier: str, request: Request):
        return await (await service(request)).decide(identifier, (await request.json()).get('decision'))
