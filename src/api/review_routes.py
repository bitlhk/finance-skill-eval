"""Human review and calibration without changing machine results."""
from fastapi import Request
from evaluation.human_review import HumanReviewStore, migration_targets, comparison_targets, migration_calibrations, comparison_calibrations
from tasks.values import canonical_fingerprint as fingerprint
from storage.coordination import CoordinationConflict
from .identity import AccessError
from .migration_routes import service as migration_service
from .run_routes import service as run_service


def store(request):
    context = request.state.workspace
    if context.get('publicDemo') or not context.get('accessToken'):
        raise AccessError('PRIVATE_WORKSPACE_REQUIRED')
    async def resolve(source):
        if source['kind'] == 'migration':
            task = await (await migration_service(request)).get(source['id'])
            run = next((run for run in task['runs'] if run['id'] == source['runId']), None)
            if not run or run['status'] == 'RUNNING':
                raise CoordinationConflict('请选择已结束的评测记录')
            return {'digest': fingerprint(run), 'targets': migration_targets(run), 'resources': {'cases': run['cases']},
                'evaluations': migration_calibrations(run, task.get('rescorings', []))}
        job = await (await run_service(request)).get(source['id'])
        if not job.get('report') or job['status'] != 'completed':
            raise CoordinationConflict('请选择已完成的对比报告')
        return {'digest': fingerprint(job['report']), 'targets': comparison_targets(job['report']),
            'resources': {'cases': job['report']['cases']}, 'evaluations': comparison_calibrations(job)}
    return HumanReviewStore(context['dataDirectory'], resolve)


def install_review_routes(app):
    @app.get('/api/evaluation-reviews')
    async def get(request: Request):
        return await store(request).get(dict(request.query_params))

    @app.post('/api/evaluation-reviews')
    async def append(request: Request):
        return await store(request).append(await request.json())
