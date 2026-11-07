import asyncio
from fastapi import Request, HTTPException
from fastapi.responses import JSONResponse, Response
from storage.history import HistoryStore


def install_history_routes(app):
    def store(request):
        config = request.state.workspace
        if config['publicDemo'] or not config['accessToken']:
            raise HTTPException(403, '历史记录仅限私有工作区查看。')
        return HistoryStore(config['dataDirectory'])

    @app.get('/api/history/tasks')
    async def tasks(request: Request):
        return await asyncio.to_thread(store(request).list, 'tasks')

    @app.get('/api/history/environments')
    async def environments(request: Request):
        return await asyncio.to_thread(store(request).list, 'environments')

    @app.get('/api/history/{origin}/{identifier}')
    async def get(request: Request, origin: str, identifier: str):
        return await asyncio.to_thread(store(request).get, origin, identifier)

    @app.get('/api/history/{origin}/{identifier}/snapshot')
    async def snapshot(request: Request, origin: str, identifier: str, revision: str):
        return await asyncio.to_thread(store(request).snapshot, origin, identifier, revision)

    @app.get('/api/history/{origin}/{identifier}/file')
    async def file(request: Request, origin: str, identifier: str, revision: str, path: str):
        if len(path) > 1000:
            raise HTTPException(400, '历史文件路径过长')
        return await asyncio.to_thread(store(request).file, origin, identifier, revision, path)

    @app.get('/api/history/{origin}/{identifier}/archive')
    async def archive(request: Request, origin: str, identifier: str):
        data = await asyncio.to_thread(store(request).archive, origin, identifier)
        return Response(data, media_type='application/zip', headers={
            'content-disposition': 'attachment; filename="historical-record.zip"'})

    @app.api_route('/api/history/{rest:path}', methods=['POST', 'PUT', 'PATCH', 'DELETE'])
    async def readonly(request: Request, rest: str):
        store(request)
        return JSONResponse({'code': 'HISTORY_READ_ONLY',
            'message': '历史记录仅供查阅，不能修改、删除或继续执行；请使用原始 Skill 新建任务。'}, status_code=409)
