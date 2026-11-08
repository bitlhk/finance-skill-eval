"""Fixed comparison-task program: prepare, freeze, execute, judge and report.

No Agent selects or changes this sequence. Existing runtime/judge adapters supply
execution results; lifecycle and repetition decisions are owned by this module.
"""
from copy import deepcopy
from tasks.application_host import call, dispatch, CapabilityError
from tasks.values import now
from .job_control import freeze, failed, cancel, report_completed


def run(request):
    job = deepcopy(request['job'])
    iteration = None

    def effect(name, *, cleanup=False, **inputs):
        return call(name, {'jobId': job['jobId'], **inputs}, cleanup=cleanup)

    try:
        job.update(status='preparing', stageLabel='环境预检与候选准备', startedAt=now())
        job = yield effect('save_job', job=job)
        if job['status'] == 'cancelled':
            return
        pack = yield effect('resolve_pack', configuration=job['configuration'])
        if job['configuration'].get('caseSource') == 'ai_generated' and not job.get('questionSet'):
            job['stageLabel'] = 'AI 正在读取 Skill 与专业参考，生成本轮试题'
            job = yield effect('save_job', job=job)
            try:
                job['questionSet'] = yield effect('generate_questions', pack=pack, configuration=job['configuration'])
            except CapabilityError as error:
                if error.detail.get('aborted'):
                    raise
                raise ValueError('AI 动态出题失败，未回退固定题：' + str(error)) from error
        pack = freeze(job, pack)
        job = yield effect('save_job', job=job)
        repeats = job['configuration'].get('executionRepetitions', 1)
        for iteration in range(repeats):
            if job['status'] == 'cancelled':
                return
            job.update(live={}, evidence=[])
            job.pop('finalization', None)
            if 'executionAttempts' in job:
                job['executionAttempts'].append({'index': iteration, 'status': 'RUNNING'})
                job = yield effect('save_job', job=job)
            result = yield effect('execute_once', job=job, pack=pack, iteration=iteration)
            job = result['job']
            if job['status'] == 'cancelled':
                return
            report_completed(job, result['report'], iteration, result['incomplete'])
            job = yield effect('save_job', job=job)
            if result['incomplete']:
                break
        if job['status'] == 'cancelled':
            return
        job.update(status='completed', stageLabel=job.get('executionRepetitionsStopped') or
            ('评测未完成：请检查运行、证据和评判结果' if job.get('assessmentIncomplete') else '评测完成'), completedAt=now())
        yield effect('save_job', job=job)
    except Exception as error:
        detail = error.detail if isinstance(error, CapabilityError) else {'name': type(error).__name__, 'message': str(error)}
        latest = yield effect('load_job', cleanup=True)
        if latest:
            job = latest
        if iteration is not None and 'executionAttempts' in job:
            job['executionAttempts'][iteration] = {'index': iteration, 'status': 'FAILED', 'error': str(error),
                **({'finalization': deepcopy(job['finalization'])} if 'finalization' in job else {})}
        failed(job, detail)
        yield effect('save_job', job=job, cleanup=True)


def execute(request):
    return dispatch(request, {'run': run})
