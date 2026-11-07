"""Fixed evaluation task lifecycle, frozen inputs, progress and repeat accounting."""
from copy import deepcopy
from uuid import uuid4
import re
from tasks.values import now, fingerprint

TERMINAL = ('completed', 'failed', 'cancelled', 'interrupted')


class EvaluationJobError(ValueError):
    def __init__(self, message, status=409):
        super().__init__(message)
        self.status = status


def _create(inputs):
    if inputs.get('closing'):
        raise EvaluationJobError('Evaluation service is closing', 503)
    stamp = now()
    return {'schemaVersion': 'finance.skill-eval.job.v1', 'jobId': 'run-' + str(uuid4()), 'status': 'queued',
        'stageLabel': '等待执行资源', 'configuration': deepcopy(inputs['configuration']), 'pack': None,
        'progress': {'completedRuns': 0, 'totalRuns': 0}, 'evidence': [], 'report': None, 'error': None,
        'createdAt': stamp, 'startedAt': None, 'completedAt': None, 'updatedAt': stamp,
        **({'questionSet': deepcopy(inputs['questionSet'])} if inputs.get('questionSet') is not None else {})}


def environment_ids(configuration):
    bindings = configuration.get('runtimeBindings')
    if bindings:
        selected = [bindings['right']] if configuration.get('evaluationMode') in ('candidate_assessment', 'service_comparison') else bindings.values()
        return list(dict.fromkeys(item['environmentId'] for item in selected))
    runtime = configuration['runtime']
    return [runtime['environmentId']] if runtime['type'] == 'runtime_launcher' else []


def pack_inputs(configuration, pack):
    result = {}
    for side in ('left', 'right'):
        variant = configuration.get(side + 'Variant') or pack['variants'][side]
        asset_id = ((configuration.get('runtimeBindings') or {}).get(side) or {}).get('skillAssetId') or configuration.get('skillAssetId')
        if variant['mode'] == 'skill_version' and not variant.get('artifactSha256') and asset_id:
            result[side] = asset_id
    return result


def resolve_pack(inputs):
    pack, config = deepcopy(inputs['pack']), inputs['configuration']
    ids = config.get('selectedCaseIds') or []
    available = {case['caseId'] for case in pack['cases']}
    missing = [ident for ident in ids if ident not in available]
    if missing:
        raise EvaluationJobError('所选评测案例不存在，请刷新题集后重新选择：' + '、'.join(missing))
    selected = [case for case in pack['cases'] if not ids or case['caseId'] in ids]
    if not selected:
        raise EvaluationJobError('没有选择任何评测用例')
    if config.get('includeHoldout'):
        if not pack.get('holdoutCases'):
            raise EvaluationJobError('这个评测题集没有冻结的留出题')
        selected.extend(pack['holdoutCases'])
    if len({case['caseId'] for case in selected}) != len(selected):
        raise EvaluationJobError('固定题与留出题 caseId 冲突，请核对题集版本')
    pack['cases'] = selected
    variants = {side: deepcopy(config.get(side + 'Variant') or pack['variants'][side]) for side in ('left', 'right')}
    for side, asset in inputs.get('assets', {}).items():
        variant = variants[side]
        if asset and asset.get('skillId') == variant.get('skillId') and asset.get('version') == variant.get('version'):
            variant['artifactSha256'] = asset['artifactSha256']
    pack['variants'] = variants
    execution = config.get('executionModel') or (inputs['defaults'].get('execution') if config['runtime']['type'] == 'direct_model' else None)
    pack['models']['execution'] = {side: deepcopy(config.get(side + 'ExecutionModel') or execution or pack['models']['execution'][side]) for side in ('left', 'right')}
    pack['models']['judge'] = deepcopy(config.get('judgeModel') or (inputs['defaults']['judge'] if config.get('judgeMode') == 'model' else pack['models']['judge']))
    return pack


def cancel(job):
    if job['status'] in TERMINAL:
        return
    job.update(status='cancelled', stageLabel='取消已请求；执行停止与回收分别核对', error=None, completedAt=now(),
        cancellation={'requestedAt': now(), 'scope': 'EVAL_WORKER_NOT_REMOTE_PROCESS_PROOF'})


def freeze(job, pack):
    pack = deepcopy(pack)
    question_set = job.get('questionSet')
    if question_set:
        cases = question_set['cases'] + (pack.get('holdoutCases') or [] if job['configuration'].get('includeHoldout') else [])
        if len({case['caseId'] for case in cases}) != len(cases):
            raise EvaluationJobError('动态题与留出题 caseId 冲突，请重新准备题集')
        pack['cases'] = deepcopy(cases)
        pack['models']['analyzer'] = question_set['model']
        job['stageLabel'] = f'已冻结 {len(cases)} 道 AI 试题，准备同题 A/B 执行'
    pack['packFingerprint'] = fingerprint({'base': pack['packFingerprint'], 'cases': pack['cases'], 'variants': pack['variants'], 'models': pack['models']})
    repetitions = job['configuration'].get('executionRepetitions', 1)
    if repetitions > 1 and job['configuration'].get('repeatSafety') != 'read_only' and any(not case.get('stateFixture') for case in pack['cases']):
        raise EvaluationJobError('重复业务运行需要全部案例配置状态恢复，或明确确认只读')
    job['pack'] = {key: pack[key] for key in ('packId', 'version', 'targetSkillId', 'targetSkillVersion')}
    job['pack']['caseCount'] = len(pack['cases'])
    job['progress']['totalRuns'] = len(pack['cases']) * 2 * repetitions
    job['executionSnapshot'] = {'variants': deepcopy(pack['variants']), 'models': deepcopy(pack['models']),
        'cases': [{key: case[key] for key in ('caseId', 'name', 'prompt')} for case in pack['cases']], 'packFingerprint': pack['packFingerprint']}
    job['evaluationSpec'] = deepcopy(pack)
    if repetitions > 1:
        job['executionAttempts'] = []
    return pack


def progress(job, events, iteration):
    if job['status'] in TERMINAL:
        return
    cases = len(job['evaluationSpec']['cases'])
    repeats = job['configuration'].get('executionRepetitions', 1)
    labels = {'preparing': '环境预检与候选准备', 'executing': '左右候选同步执行', 'judging': '匿名专业 Judge 评阅', 'completed': '评测完成'}
    for item in events:
        event = item.get('event')
        if event:
            key = event['caseId'] + ':' + event['side']
            live = job.setdefault('live', {}).setdefault(key, {'caseId': event['caseId'], 'side': event['side'], 'output': '', 'status': '执行中', 'toolCalls': []})
            if event['type'] == 'text_delta':
                live['output'] += event.get('text') or ''
            elif event['type'] == 'status':
                live['status'] = event.get('text') or '执行中'
            elif event['type'] == 'tool_start':
                live['toolCalls'].append({'name': event.get('toolName') or 'tool', 'status': 'running'})
            elif event['type'] == 'tool_end':
                tool = next((tool for tool in reversed(live['toolCalls']) if tool['name'] == event.get('toolName') and tool['status'] == 'running'), None)
                if tool:
                    tool['status'] = event.get('status') or 'completed'
            job.update(status='running', stageLabel=labels['executing'])
            continue
        stage = item['stage']
        job.update(status='judging' if stage == 'judging' else 'preparing' if stage == 'preparing' else 'running', stageLabel=labels.get(stage, '评测完成'))
        job['progress'] = {'completedRuns': iteration * cases * 2 + item['completedRuns'], 'totalRuns': repeats * cases * 2,
            **{key: item[key] for key in ('caseId', 'side') if item.get(key)}}
        if item.get('evidence'):
            evidence = item['evidence']
            job['evidence'] = [old for old in job['evidence'] if old and (old['caseId'], old['side']) != (evidence['caseId'], evidence['side'])]
            job['evidence'].append(deepcopy(evidence))


def report_completed(job, report, iteration, incomplete):
    report = deepcopy(report)
    report['executionBindings'] = {'basis': 'MODEL_PROVIDER_IS_CONFIGURATION_REFERENCE_NOT_RUNTIME_IDENTITY',
        'runtime': deepcopy(job['configuration']['runtime']), 'sides': deepcopy(job['configuration'].get('runtimeBindings'))}
    if job.get('questionSet'):
        report['questionSet'] = deepcopy(job['questionSet'])
    report.pop('reportFingerprint', None)
    report['reportFingerprint'] = fingerprint(report)
    job['report'] = report
    if 'executionAttempts' in job:
        job['executionAttempts'][iteration] = {'index': iteration, 'status': 'COMPLETED', 'report': deepcopy(report),
            **({'finalization': deepcopy(job['finalization'])} if 'finalization' in job else {})}
    if incomplete:
        job['assessmentIncomplete'] = True
        if iteration + 1 < job['configuration'].get('executionRepetitions', 1):
            job['executionRepetitionsStopped'] = '执行、证据或评判不完整，后续业务运行未执行'


def failed(job, detail):
    if job['status'] == 'cancelled' or detail.get('aborted') or detail.get('name') == 'EvaluationCancelledError':
        cancel(job)
        return
    message = detail.get('message') or '评测未完成'
    code = ('QUESTION_GENERATION_FAILED' if re.search('动态出题', message) else
            'ENVIRONMENT_PREFLIGHT_FAILED' if re.search('preflight|health|environment', message, re.I) else
            'MODEL_CONFIGURATION_FAILED' if re.search('credential|api key|model', message, re.I) else
            'RUNTIME_TOOL_SUPPORT_REQUIRED' if re.search('tool', message, re.I) else 'EVALUATION_EXECUTION_FAILED')
    job.update(status='failed', stageLabel='评测失败', error={'code': code, 'message': message, 'retryable': True}, completedAt=now())


def execute(request):
    action, inputs = request['action'], request.get('inputs') or {}
    if action == 'create':
        return {'job': _create(inputs)}
    if action == 'environment_ids':
        return environment_ids(inputs['configuration'])
    if action == 'pack_inputs':
        return pack_inputs(inputs['configuration'], inputs['pack'])
    if action == 'resolve_pack':
        return resolve_pack(inputs)
    job = deepcopy(request['job'])
    if action in ('rescore_admit', 'rescore_start'):
        if inputs.get('closing') or job.get('report') is None or job.get('evaluationSpec') is None or job['status'] != 'completed':
            raise EvaluationJobError('该记录未保存完整评判方案，请重新运行')
        if inputs.get('busy') or action == 'rescore_start' and (job.get('rescoringOperation') or {}).get('status') == 'RUNNING':
            raise EvaluationJobError('正在重新评判')
        if action == 'rescore_start':
            job['rescoringOperation'] = {'id': 'rescore-op-' + str(uuid4()), 'status': 'RUNNING', 'startedAt': now()}
        return {'job': job}
    if action == 'rescore_finished':
        operation = job.get('rescoringOperation')
        if operation and operation['id'] == inputs['operationId']:
            operation.update(status='FAILED' if inputs.get('error') else 'COMPLETED', finishedAt=now())
            operation.update({'error': inputs['error']} if inputs.get('error') else {'recordId': inputs['recordId']})
        return {'job': job}
    if action == 'rescore_commit':
        record = inputs['record']
        if (job.get('report') or {}).get('reportFingerprint') != record['sourceReportFingerprint']:
            raise EvaluationJobError('原报告已变化')
        job.setdefault('rescorings', []).append(deepcopy(record))
        return {'job': job}
    if action == 'retry':
        if job['status'] not in ('failed', 'cancelled', 'interrupted'):
            raise EvaluationJobError('只有失败、已取消或已中断的运行可以重试')
        return {'configuration': job['configuration'], 'questionSet': job.get('questionSet')}
    if action == 'cancel':
        cancel(job)
    elif action == 'progress':
        progress(job, inputs['events'], inputs['iteration'])
    else:
        raise ValueError('Unknown evaluation task command')
    return {'job': job}
