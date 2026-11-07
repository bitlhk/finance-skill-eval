"""Existing environment endpoints backed by the native shared registry."""
from fastapi import Request, Response, HTTPException
from runtime.environments import EnvironmentStore


def store(request):
    context = request.state.workspace
    return EnvironmentStore(context['dataDirectory'], context.get('launcherTrust'))


def install_environment_routes(app):
    @app.get('/api/environments')
    async def list_environments(request: Request):
        if set(request.query_params) - {'includeArchived'} or request.query_params.get('includeArchived', 'false') not in ('true', 'false'):
            raise ValueError('Invalid environment list options')
        return await store(request).list(request.query_params.get('includeArchived') == 'true')

    @app.get('/api/environments/{identifier}')
    async def get_environment(identifier: str, request: Request):
        record = await store(request).get(identifier)
        if not record:
            raise HTTPException(404, 'Environment not found')
        return record

    @app.post('/api/environments')
    async def create_environment(request: Request):
        return await store(request).mutate('create', value=await request.json())

    @app.put('/api/environments/{identifier}')
    async def update_environment(identifier: str, request: Request):
        return await store(request).mutate('update', identifier, await request.json())

    @app.patch('/api/environments/{identifier}/archive')
    async def archive_environment(identifier: str, request: Request):
        return await store(request).mutate('archive', identifier, await request.json())

    @app.delete('/api/environments/{identifier}')
    async def delete_environment(identifier: str, request: Request):
        await store(request).mutate('remove', identifier)
        return Response(status_code=204)

    @app.post('/api/environments/{identifier}/preflight')
    async def preflight_environment(identifier: str, request: Request):
        registry = store(request)
        return await registry.inspect(await registry.require_available(identifier))
