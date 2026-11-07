"""Standalone optimization application over the shared engineering/evaluation Agents.

The Jiuwen coordinator chooses operations. This controller owns immutable inputs,
filesystem ownership, user decisions and evidence provenance, not another loop.
"""
import asyncio
import base64
from contextlib import asynccontextmanager
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import io
from pathlib import Path
import re
from uuid import uuid4
import zipfile

from agents.criterion import QuietOutput
from agents.diagnosis import diagnose
from agents.review import review
from api.contracts import parse
from evaluation.checks import comparison_incomplete
from improvement.engineering import adjust
from improvement.policy import comparison_evaluation, comparable, holdout_goal, review_input, select
from improvement.source import changes, source_evidence, version_entry
from runtime.agent_client import AgentRuntimeClient
from runtime.models import configured_model_role
from storage.tasks import read_json, write_json
from tasks.values import fingerprint, now
from agents.optimization import run as coordinate_optimization


ACTIVE = {'diagnosing', 'validating', 'reevaluating', 'reviewing', 'final_verifying'}


class OptimizationService:
    def __init__(self, workspace, runs, *, engineering=adjust, diagnostic=diagnose,
                 reviewer=review, coordinator=coordinate_optimization):
        self.workspace, self.runs = workspace, runs
        self.library, self.environments = runs.library, runs.environments
        from storage.repository import TaskRepository
        self.repository = TaskRepository(workspace['dataDirectory'])
        self.directory = Path(workspace['dataDirectory']) / 'optimizations'
        self.engineering, self.diagnostic, self.reviewer, self.coordinator = engineering, diagnostic, reviewer, coordinator
        self.active, self.closing = {}, False

    def path(self, identifier):
        if not re.fullmatch(r'opt-[a-f0-9-]+', identifier):
            raise ValueError('优化记录 ID 不合法')
        return self.directory / (identifier + '.json')

    async def save(self, item):
        item['updatedAt'] = now()
        await asyncio.to_thread(write_json, self.path(item['optimizationId']), item)

    async def stage(self, item, status):
        item['status'] = status
        item['stages'].append({'stage': status, 'at': now()})
        await self.save(item)

    async def get(self, identifier):
        # A live owner may publish a newer atomic record during this read.
        item = await asyncio.to_thread(read_json, self.path(identifier))
        if item['status'] in ACTIVE and not await self.busy(identifier):
            async with self.reservation():
                item = await asyncio.to_thread(read_json, self.path(identifier))
                if item['status'] in ACTIVE and not await self.busy(identifier):
                    if (item.get('loop') or {}).get('status') == 'RUNNING':
                        item['loop'].update(status='INTERRUPTED', reason='执行已中断，候选未采纳')
                    pending = item.get('engineeringInteraction') or {}
                    item['status'] = 'interrupted' if pending.get('answer') and pending.get('executionId') and pending.get('resumeLoop') else 'failed'
                    item['error'] = '执行已中断；请核对原 Agent 执行状态后恢复' if item['status'] == 'interrupted' else '服务已重启，候选未采纳'
                    await self.save(item)
        return item

    async def records(self):
        return [await asyncio.to_thread(read_json, file) for file in self.directory.glob('*.json')]

    async def for_source(self, identifier):
        items = [item for item in await self.records() if item['sourceJobId'] == identifier]
        return await self.get(max(items, key=lambda item: item['createdAt'])['optimizationId']) if items else None

    async def busy(self, identifier):
        from storage.coordination import execute
        return await asyncio.to_thread(execute, {'root': self.repository.root,
            'key': 'optimization-execution:' + identifier, 'action': 'busy'})

    @asynccontextmanager
    async def reservation(self):
        token = await self.repository.acquire('optimization-admission', 5000)
        if not token:
            raise ValueError('其他请求正在更新优化任务，请稍后重试')
        try:
            yield
        finally:
            await self.repository.release('optimization-admission', token)

    async def suite(self, configuration):
        if configuration.get('packId'):
            pack = await asyncio.to_thread(self.runs.catalog.get, configuration['packId'])
        else:
            preparation = await asyncio.to_thread(self.runs.preparations.get, configuration.get('preparationId'))
            pack = self.runs.preparations.build_pack(preparation, configured_model_role('ANALYZER')['model'],
                configuration.get('executionModel') or configured_model_role('EXECUTION')['model'], configured_model_role('JUDGE')['model']) if preparation else None
        if not pack:
            raise ValueError('找不到评测试卷，不能启动优化')
        return pack

    async def protocol(self, source, pack=None):
        configuration = source['configuration']
        ids = set(binding['environmentId'] for binding in (configuration.get('runtimeBindings') or {}).values())
        if configuration['runtime']['type'] == 'runtime_launcher':
            ids.add(configuration['runtime']['environmentId'])
        runtime = [await self.environments.get(identifier) for identifier in sorted(ids)]
        return fingerprint({'pack': pack or await self.suite(configuration), 'questions': source.get('questionSet'),
            'configuration': configuration, 'judge': configured_model_role('JUDGE')['model'], 'runtime': runtime})

    async def assert_protocol(self, item):
        source = await self.runs.get(item['sourceJobId'])
        if await self.protocol(source) != item['evaluationFingerprint']:
            raise ValueError('评测条件已变化，不能继续原优化任务')
        return source

    async def holdout_available(self, digest, exclude=None):
        if any(item['optimizationId'] != exclude and item.get('holdoutFingerprint') == digest and
               (item.get('holdoutJobId') or item['status'] == 'final_verifying') for item in await self.records()):
            raise ValueError('这份留出集已用于最终复核或正在复核，请准备新的独立留出集')

    async def launch(self, item, operation):
        if self.closing:
            raise ValueError('服务正在关闭')
        identifier = item['optimizationId']
        key = 'optimization-execution:' + identifier
        token = await self.repository.acquire(key)
        if not token:
            raise ValueError('优化任务正在其他实例运行')
        try:
            await self.save(item)
        except BaseException:
            await self.repository.release(key, token)
            raise
        async def work():
            operation_task = asyncio.create_task(operation())
            async def monitor():
                while not operation_task.done():
                    if self.path(identifier).with_suffix('.cancel').exists():
                        operation_task.cancel()
                        return
                    deadline = (item.get('loop') or {}).get('deadlineAt')
                    if deadline and datetime.now(timezone.utc) >= datetime.fromisoformat(deadline.replace('Z', '+00:00')):
                        item['budgetExhausted'] = True
                        operation_task.cancel()
                        return
                    await asyncio.sleep(.2)
            monitor_task = asyncio.create_task(monitor())
            try:
                await operation_task
            except asyncio.CancelledError:
                for job_id in (item.get('rerunJobId'), item.get('holdoutJobId')):
                    if job_id:
                        job = await self.runs.get(job_id)
                        if job['status'] not in ('completed', 'failed', 'cancelled', 'interrupted'):
                            await self.runs.cancel(job_id)
                pending = item.get('engineeringInteraction') or {}
                if item.get('budgetExhausted'):
                    state = item.get('loop') or {}
                    best = state.get('best')
                    item['candidate'] = await self.library.call('get', id=best['id']) if best and best != state.get('baseline') else None
                    if item['candidate']:
                        item['rerunJobId'] = state['bestEvaluationId']
                        selected = next((entry for entry in reversed(state.get('rounds', [])) if entry.get('selected') and entry.get('candidate') == best), {})
                        item.update(effectReview=selected.get('review'), reviewJobId=state['bestEvaluationId'])
                    state.update(status='REVIEW' if item['candidate'] else 'STOPPED', reason='已用完优化时间预算；保留审查认可的推荐版本', finishedAt=now())
                    item.update(loop=state, summary=state['reason'], error=None)
                    await self.stage(item, 'review' if item['candidate'] else 'retained')
                else:
                    item['error'] = '执行中断，结果及用户回答已保存'
                    await self.stage(item, 'cancelled' if self.path(identifier).with_suffix('.cancel').exists() else 'interrupted')
            except Exception as error:
                item['error'] = str(error)[:2000]
                await self.stage(item, 'failed')
            finally:
                monitor_task.cancel()
                operation_task.cancel()
                await asyncio.gather(monitor_task, operation_task, return_exceptions=True)
                self.active.pop(identifier, None)
                await self.repository.release(key, token)
        self.active[identifier] = asyncio.create_task(work(), name=key)
        return deepcopy(item)

    async def create(self, source_id, goal_input=None):
        source = await self.runs.get(source_id)
        goal = parse('optimization_goal', goal_input or {})
        report, configuration = source.get('report'), source['configuration']
        if configuration.get('includeHoldout'):
            raise ValueError('留出集结果不能作为优化依据')
        if source['status'] != 'completed' or not report or configuration['runtime']['type'] != 'runtime_launcher':
            raise ValueError('请先使用 Runtime Launcher 完成一轮在线评测')
        self.complete(source)
        if not report['cases']:
            raise ValueError('评测没有实际执行案例')
        binding = configuration.get('runtimeBindings')
        if binding and binding['left']['environmentId'] != binding['right']['environmentId']:
            raise ValueError('跨执行栈差异不能直接归因于 Skill；请先在同一 Runtime 完成评测')
        models = report['models']['execution']
        identity = lambda model: {key: model.get(key, {}) if key == 'parameters' else model.get(key) for key in ('providerId', 'modelId', 'parameters')}
        if fingerprint(identity(models['left'])) != fingerprint(identity(models['right'])):
            raise ValueError('请先用相同执行模型及参数评测，再判断 Skill 增益')
        asset = await self.library.resolve(report['variants']['right'], (binding or {}).get('right', {}).get('skillAssetId'))
        if not asset:
            raise ValueError('原始 Skill 文件不可用')
        pack = await self.suite(configuration)
        ids = self.development_ids(source, pack)
        if any(identifier not in ids for identifier in goal.get('protectedCaseIds', [])):
            raise ValueError('必须通过的案例不属于本次开发集')
        optimizer = configured_model_role('OPTIMIZER')
        if not optimizer['configured']:
            raise ValueError('优化模型未配置')
        async with self.reservation():
            holdout = fingerprint(pack['holdoutCases']) if pack.get('holdoutCases') else None
            if holdout:
                await self.holdout_available(holdout)
            item = {'optimizationId': 'opt-' + str(uuid4()), 'sourceJobId': source_id, 'sourceAssetId': asset['assetId'],
                'createdAt': now(), 'updatedAt': now(), 'status': 'diagnosing', 'modelId': optimizer['model']['modelId'],
                'summary': '', 'findings': [], 'changes': [], 'candidate': None, 'rerunJobId': None, 'error': None,
                'stages': [{'stage': 'diagnosing', 'at': now()}], 'goal': goal, 'evaluationFingerprint': await self.protocol(source, pack)}
            if holdout:
                item['holdoutFingerprint'] = holdout
            return await self.launch(item, lambda: self.optimize(item))

    @staticmethod
    def development_ids(source, pack):
        allowed = {case['caseId'] for case in (source.get('questionSet') or {}).get('cases', pack['cases'])}
        return [case['caseId'] for case in source['report']['cases'] if case['caseId'] in allowed]

    @staticmethod
    def complete(job):
        if job.get('assessmentIncomplete') or job.get('executionRepetitionsStopped') or not job.get('report') or comparison_incomplete(job['report']) or (
                job['configuration'].get('executionRepetitions', 1) > 1 and len(job.get('executionAttempts', [])) != job['configuration']['executionRepetitions']):
            raise ValueError('运行、证据或评判不完整，请先修复并重新评测')
        if any(case[side]['status'] != 'completed' or not case.get('judge') for case in job['report']['cases'] for side in ('left', 'right')):
            raise ValueError('运行或阅卷不完整，应修复环境后重测')

    async def edit(self, item, job, asset_id, diagnosis, reattach=False):
        archive = await self.library.call('readArchive', id=asset_id)
        original = await self.library.call('readArchive', id=item['sourceAssetId'])
        item.setdefault('engineeringSessionId', 'bundle-' + item['optimizationId'][4:])
        await self.save(item)
        ids = self.development_ids(job, await self.suite(job['configuration']))
        pending = item.get('engineeringInteraction') or {}
        continuation = {**pending, 'reattach': reattach} if pending.get('answer') else None
        async def composition(value):
            item['agentComposition'] = value
            await self.save(item)
        delivery = item.get('deliveryToolsByAsset', {}).get(asset_id)
        if delivery is None and job['configuration'].get('runtimeMcpBindings'):
            delivery = {'services': [{key: deepcopy(value) for key, value in service.items()
                                     if key in ('toolNames', 'filePaths', 'start', 'prepare')}
                                    for service in job['configuration']['runtimeMcpBindings']['right']], 'tools': []}
        edited = await self.engineering(self.repository.root, item['engineeringSessionId'], original, archive, item['goal']['goal'],
            [{'runId': job['jobId'], 'phase': 'development', 'candidateId': asset_id, 'status': job['status'],
              'cases': [{'id': case['caseId'], 'task': case['prompt'], 'result': case['right'], 'review': case.get('judge')}
                        for case in job['report']['cases'] if case['caseId'] in ids]}],
            diagnosis=diagnosis, constraints=item.get('constraints'), continuation=continuation, on_composition=composition,
            **({'delivery_tools': delivery} if delivery is not None else {}))
        if edited['status'] == 'WAITING':
            item['engineeringInteraction'] = {key: edited[key] for key in ('attemptId', 'interactions')}
            await self.save(item)
            return {'status': 'WAITING', 'kind': 'INPUT', 'candidate': {'id': asset_id, 'digest': (await self.library.call('get', id=asset_id))['artifactSha256']}, 'reason': '等待回答 Agent 的问题'}
        item.pop('engineeringInteraction', None)
        if edited['status'] == 'ABSTAINED' or not edited.get('changed'):
            item.update(candidate=None, summary=edited.get('reason', '候选没有有效变化'))
            return None
        entries = [name for name in edited['files'] if re.search(r'(^|/)skill\.md$', name, re.I)]
        if len(entries) != 1:
            raise ValueError('候选需要且只能包含一个 Skill 入口')
        asset = await self.library.call('get', id=asset_id)
        version = asset['version'] + '-candidate.' + uuid4().hex[:8]
        files = version_entry(edited['files'], entries[0], version)
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as bundle:
            for name, value in files.items():
                bundle.writestr(name, base64.b64decode(value, validate=True))
        candidate = await self.library.call('upload', archive=base64.b64encode(output.getvalue()).decode(), version=version, preserveIdentityFrom=asset_id)
        if edited.get('deliveryTools') is not None or delivery is not None:
            item.setdefault('deliveryToolsByAsset', {})[candidate['assetId']] = deepcopy(edited.get('deliveryTools', delivery))
        item.update(summary=edited['summary'], findings=[], changes=changes(archive, files), candidate=candidate)
        await self.save(item)
        return {'id': candidate['assetId'], 'digest': candidate['artifactSha256']}

    async def evaluate(self, item, *, final=False):
        source = await self.assert_protocol(item)
        pack = await self.suite(source['configuration'])
        original, candidate = await self.library.call('get', id=item['sourceAssetId']), item['candidate']
        variant = lambda asset: {'mode': 'skill_version', **{key: asset[key] for key in ('skillId', 'version', 'artifactSha256')}}
        configuration = {**deepcopy(source['configuration']), 'caseSource': 'fixed', 'includeHoldout': final,
            'selectedCaseIds': [] if source.get('questionSet') else self.development_ids(source, pack),
            'leftVariant': variant(original), 'rightVariant': variant(candidate), 'skillAssetId': candidate['assetId']}
        if configuration.get('runtimeBindings'):
            binding = deepcopy(configuration['runtimeBindings']['right'])
            environment = binding['environmentId']
            configuration.update(runtime={'type': 'runtime_launcher', 'environmentId': environment}, runtimeBindings={
                'left': {**deepcopy(binding), 'skillAssetId': original['assetId']},
                'right': {**binding, 'skillAssetId': candidate['assetId']}})
        # Keep the actual delivery entrypoints and bind each to the archive being
        # executed. The baseline stays immutable; a new archive has a new digest.
        for name in ('runtimeCommandBindings', 'runtimeMcpBindings'):
            if name in configuration:
                configuration[name]['left'] = deepcopy(configuration[name]['right'])
        delivery = item.get('deliveryToolsByAsset', {}).get(candidate['assetId'])
        if delivery is not None:
            configuration.setdefault('runtimeMcpBindings', {'left': [], 'right': []})['right'] = deepcopy(delivery['services'])
        if configuration.get('runtimeMcpBindings'):
            for side, asset in (('left', original), ('right', candidate)):
                for service in configuration['runtimeMcpBindings'][side]:
                    service['assetDigest'] = asset['artifactSha256']
        rerun = await self.runs.create(configuration, source.get('questionSet'))
        item['holdoutJobId' if final else 'rerunJobId'] = rerun['jobId']
        if not final and (item.get('loop') or {}).get('rounds'):
            item['loop']['rounds'][-1]['evaluationId'] = rerun['jobId']
        await self.stage(item, 'final_verifying' if final else 'reevaluating')
        while True:
            current = await self.runs.get(rerun['jobId'])
            if current['status'] in ('failed', 'cancelled', 'interrupted'):
                raise ValueError((current.get('error') or {}).get('message', '候选评测未完成'))
            if current['status'] == 'completed':
                self.complete(current)
                await self.assert_protocol(item)
                if fingerprint(current['report']['models']['execution']) != fingerprint(source['report']['models']['execution']):
                    raise ValueError('复测执行模型与基线不一致')
                if final:
                    view = comparison_evaluation(current, {'id': candidate['assetId'], 'digest': candidate['artifactSha256']},
                        [case['caseId'] for case in pack['holdoutCases']], item['evaluationFingerprint'])
                    if not holdout_goal(view['cases'], item['goal']['targetPassRate']):
                        raise ValueError('留出集未达到设定目标或验证未完成，不能采纳候选')
                    item['holdoutVerified'] = True
                return current
            await asyncio.sleep(.2)

    async def effect_review(self, item, before, after, incumbent=None, remaining=0):
        material = review_input(item['goal']['goal'], before, after, item['changes'],
            {'incumbent': incumbent or before, 'protectedCaseIds': item['goal'].get('protectedCaseIds', []),
             'targetPassRate': item['goal']['targetPassRate'], 'remainingRounds': remaining})
        return await self.reviewer(material, 'optimization-' + fingerprint({'workspace': self.repository.root, 'optimizationId': item['optimizationId']}),
            'attempt-' + str(uuid4()), self.repository.root)

    async def optimize(self, item, resuming=False, reattach=False, *, resume_phase='ADJUSTMENT'):
        source = await self.assert_protocol(item)
        ids = self.development_ids(source, await self.suite(source['configuration']))
        asset = await self.library.call('get', id=item['sourceAssetId'])
        baseline = {'id': asset['assetId'], 'digest': asset['artifactSha256']}
        state = item['loop'] if resuming else {'id': item['optimizationId'], 'goal': item['goal'], 'baseline': baseline,
            'best': baseline, 'bestEvaluationId': source['jobId'], 'status': 'RUNNING', 'stage': 'DIAGNOSIS', 'rounds': [], 'createdAt': now()}
        if not resuming and item['goal'].get('maxDurationSeconds'):
            state['deadlineAt'] = (datetime.now(timezone.utc) + timedelta(seconds=item['goal']['maxDurationSeconds'])).isoformat()
        view = lambda job, candidate: comparison_evaluation(job, candidate, ids, item['evaluationFingerprint'])
        initial = view(source, baseline)
        resume = {'phase': resume_phase, 'working': view(await self.runs.get(state['workingEvaluationId']), state['working']),
            'incumbent': view(await self.runs.get(state['bestEvaluationId']), state['best'])} if resuming else None
        if resume and resume_phase == 'EVALUATION':
            resume['candidate'] = {'id': item['candidate']['assetId'], 'digest': item['candidate']['artifactSha256']}
        reattach_pending = reattach
        async def invoke(name, payload):
            nonlocal reattach_pending
            if name == 'save':
                item['loop'] = deepcopy(payload['state'])
                if item['loop']['status'] == 'RUNNING':
                    item['status'] = {'DIAGNOSIS': 'diagnosing', 'ADJUSTMENT': 'validating', 'EVALUATION': 'reevaluating', 'REVIEW': 'reviewing', 'SELECTION': 'reviewing'}[item['loop']['stage']]
                await self.save(item)
                return None
            if name == 'activate':
                selected = payload['evaluation']
                item['candidate'] = await self.library.call('get', id=selected['candidate']['id']) if selected['candidate'] != baseline else None
                item['rerunJobId'] = selected['id'] if item['candidate'] else None
                if item['candidate']:
                    item['changes'] = changes(await self.library.call('readArchive', id=item['sourceAssetId']),
                        await self.library.call('readArchive', id=item['candidate']['assetId']))
                await self.save(item)
                return None
            if name == 'diagnose':
                evaluation = payload['baseline']
                job = await self.runs.get(evaluation['id'])
                evidence = source_evidence(await self.library.call('readArchive', id=evaluation['candidate']['id']))
                cases = [case for case in job['report']['cases'] if case['caseId'] in ids]
                tools = sorted({tool['name'] for case in cases for tool in case['right'].get('toolCalls', [])})
                result = await self.diagnostic({'modelId': item['modelId'], 'sourceJobId': job['jobId'],
                    'baseSolutionRevisionId': evaluation['candidate']['digest'], 'tools': [{'toolId': name, 'name': name, 'form': 'OBSERVED'} for name in tools],
                    'runtimeConfiguration': [], 'technicalEvidence': [], 'cases': [{'caseId': case['caseId'], 'task': case['prompt'],
                        'runtimeStatus': case['right']['status'], 'runtimeIdentityVerified': case['right'].get('runtimeIdentityVerified'),
                        'streamCompleted': case['right'].get('streamCompleted'), 'toolCalls': case['right'].get('toolCalls', []),
                        'review': (case.get('judge') or {}).get('summary'), 'verdict': 'PASS' if next(value for value in evaluation['cases'] if value['id'] == case['caseId'])['passed'] is True else 'FAIL'} for case in cases],
                    'codeEvidence': evidence['files'], 'evaluationEvidence': {'current': cases, 'baseline': [case for case in source['report']['cases'] if case['caseId'] in ids]},
                    'approvedReuseDesign': {'goal': item['goal'], 'constraints': item.get('constraints'), 'sourceMaterialsOmitted': evidence['omitted']},
                    'previousExperiments': payload.get('history', [])})
                proposal = result['judgement']
                if proposal['status'] == 'PROPOSED' and any(identifier not in ids for identifier in proposal['hypothesis']['evidenceCaseIds']):
                    raise ValueError('诊断引用了开发集之外的案例')
                return {'value': proposal, 'investigation': result.get('investigation', []),
                    'compositions': [result['agentComposition']] if result.get('agentComposition') else []}
            if name == 'adjust':
                diagnosis = payload['diagnosis']
                if diagnosis['status'] != 'PROPOSED' or diagnosis['hypothesis']['layer'] not in ('SKILL', 'TOOL'):
                    return {'value': None}
                should_reattach, reattach_pending = reattach_pending, False
                value = await self.edit(item, await self.runs.get(state.get('workingEvaluationId', state['bestEvaluationId'])), payload['baseline']['id'], diagnosis, should_reattach)
                return {'value': value}
            if name == 'evaluate':
                if resume_phase == 'EVALUATION' and resuming and item.get('rerunJobId'):
                    saved = await self.runs.get(item['rerunJobId'])
                    if saved['status'] == 'completed' and saved.get('report') and saved['report']['variants']['right']['artifactSha256'] == payload['candidate']['digest']:
                        self.complete(saved)
                        return {'value': view(saved, payload['candidate'])}
                if item.get('rerunJobId'):
                    item.setdefault('previousRerunJobIds', []).append(item['rerunJobId'])
                return {'value': view(await self.evaluate(item), payload['candidate'])}
            if name == 'review':
                reviewed = await self.effect_review(item, payload['before'], payload['after'], payload.get('incumbent'), item['goal']['maxRounds'] - payload['round']['number'])
                item.update(effectReview=reviewed, reviewJobId=payload['after']['id'])
                return {'value': reviewed}
            raise ValueError('Unsupported optimization operation: ' + name)
        await self.coordinator({'state': state, 'baseline': initial, **({'resume': resume} if resume else {})}, QuietOutput(), invoke=invoke)
        item['loop'] = state
        if state['status'] == 'WAITING':
            item['summary'] = state.get('reason', '等待补充信息')
            await self.stage(item, 'waiting')
            return
        if state['best'] != baseline:
            item['candidate'] = await self.library.call('get', id=state['best']['id'])
            item['rerunJobId'] = state['bestEvaluationId']
            selected = next((entry for entry in reversed(state['rounds']) if entry.get('selected') and entry.get('candidate') == state['best']), {})
            item.update(effectReview=selected.get('review'), reviewJobId=state['bestEvaluationId'])
        else:
            item['candidate'] = None
        item['summary'] = state.get('reason', '')
        if state['status'] in ('FAILED', 'CANCELLED'):
            item['error'] = state.get('reason', '优化未完成')
        await self.stage(item, {'WAITING': 'waiting', 'REVIEW': 'review', 'FAILED': 'failed', 'CANCELLED': 'cancelled'}.get(state['status'], 'retained'))

    async def answer(self, identifier, value, *, recover=False):
        item = await self.get(identifier)
        async with self.reservation():
            item = await asyncio.to_thread(read_json, self.path(identifier))
            pending = item.get('engineeringInteraction') or {}
            if await self.busy(identifier):
                if not recover and pending.get('answer') == value:
                    return item
                raise ValueError('优化任务正在运行')
            await self.assert_protocol(item)
            if recover:
                state = item.get('loop') or {}
                rounds = state.get('rounds') or []
                candidate = item.get('candidate')
                if (not candidate and rounds and rounds[-1].get('candidate')
                        and state.get('stage') in ('ADJUSTMENT', 'EVALUATION', 'REVIEW', 'SELECTION')):
                    retained = rounds[-1]['candidate']
                    candidate = await self.library.call('get', id=retained['id'])
                    if candidate['artifactSha256'] != retained['digest']:
                        raise ValueError('保存的实验版本与候选摘要不一致')
                if (not pending.get('answer') and item['status'] in ('interrupted', 'cancelled', 'failed')
                        and candidate and not item.get('holdoutJobId') and rounds
                        and rounds[-1].get('candidate') == {'id': candidate['assetId'], 'digest': candidate['artifactSha256']}
                        and state.get('stage') in ('ADJUSTMENT', 'EVALUATION', 'REVIEW', 'SELECTION')):
                    if item.get('budgetExhausted') or state.get('deadlineAt') and datetime.now(timezone.utc) >= datetime.fromisoformat(state['deadlineAt'].replace('Z', '+00:00')):
                        raise ValueError('优化时间预算已用尽，不能直接接续')
                    state['waiting'] = {'kind': 'EXECUTION', 'candidate': rounds[-1]['candidate'],
                        'reason': '用户请求接续已发布候选的评测与独立审查', 'since': now()}
                    if not item.get('rerunJobId') and rounds[-1].get('evaluationId'):
                        item['rerunJobId'] = rounds[-1]['evaluationId']
                    await asyncio.to_thread(self.path(identifier).with_suffix('.cancel').unlink, missing_ok=True)
                    item.update(error=None, status='reevaluating', candidate=candidate)
                    return await self.launch(item, lambda: self.optimize(item, True, resume_phase='EVALUATION'))
                if item['status'] != 'interrupted' or not pending.get('answer') or not pending.get('executionId') or not pending.get('resumeLoop'):
                    raise ValueError('该优化任务没有可核对的中断执行')
                status = await AgentRuntimeClient().execution_status(item['engineeringSessionId'], pending['executionId'])
                if not status['available']:
                    raise ValueError('原 Agent 执行不可用，回答已保留，不能自动重复执行')
                item['loop'] = deepcopy(pending['resumeLoop'])
            else:
                if not isinstance(value, dict) or set(value) != {'interactionId', 'answers'} or not isinstance(value['answers'], dict) or not value['answers']:
                    raise ValueError('请填写问题的回答')
                if item['status'] != 'waiting' or (item.get('loop', {}).get('waiting') or {}).get('kind') != 'INPUT' or pending.get('answer'):
                    raise ValueError('该优化任务没有等待回答的问题')
                match = next((entry for entry in pending.get('interactions', []) if entry.get('id', entry.get('interaction_id')) == value['interactionId']), None)
                questions = [entry.get('question') for entry in (match or {}).get('value', match or {}).get('questions', [])]
                if not questions or set(questions) != set(value['answers']) or len(questions) != len(value['answers']) or any(not isinstance(answer, str) or not answer.strip() or len(answer) > 16000 for answer in value['answers'].values()):
                    raise ValueError('回答与当前问题不匹配')
                remaining = item['loop']['waiting'].get('remainingMs')
                if remaining is not None:
                    item['loop']['deadlineAt'] = (datetime.now(timezone.utc) + timedelta(milliseconds=remaining)).isoformat()
                pending.update(answer=value, executionId=str(uuid4()), resumeLoop=deepcopy(item['loop']))
                item['engineeringInteraction'] = pending
            item.update(error=None, status='validating')
            return await self.launch(item, lambda: self.optimize(item, True, recover))

    async def reevaluate(self, identifier, *, final=False):
        await self.get(identifier)
        async with self.reservation():
            item = await asyncio.to_thread(read_json, self.path(identifier))
            if await self.busy(identifier) or not item.get('candidate') or item.get('holdoutJobId') or item['status'] not in ('review', 'failed') or item.get('proposalOnly'):
                raise ValueError('请先完成开发集复测；留出集复核后不能继续迭代')
            await self.assert_protocol(item)
            if final:
                if not item.get('holdoutFingerprint') or item['status'] != 'review':
                    raise ValueError('本次优化没有可复核的独立留出集')
                await self.holdout_available(item['holdoutFingerprint'], identifier)
                self.require_review(item)
            else:
                if item.get('rerunJobId'):
                    item.setdefault('previousRerunJobIds', []).append(item['rerunJobId'])
                item.pop('effectReview', None)
                item.pop('reviewJobId', None)
            item.update(error=None, status='final_verifying' if final else 'reevaluating')
            async def work():
                job = await self.evaluate(item, final=final)
                if not final and item.get('loop'):
                    await self.stage(item, 'reviewing')
                    source = await self.runs.get(item['sourceJobId'])
                    ids = self.development_ids(source, await self.suite(source['configuration']))
                    before = comparison_evaluation(source, item['loop']['baseline'], ids, item['evaluationFingerprint'])
                    after = comparison_evaluation(job, {'id': item['candidate']['assetId'], 'digest': item['candidate']['artifactSha256']}, ids, item['evaluationFingerprint'])
                    if not comparable(before, after):
                        raise ValueError('复测未完成或评测条件不可比')
                    reviewed = await self.effect_review(item, before, after)
                    decision = select(before, after, before, reviewed, item['goal'].get('protectedCaseIds', []))
                    if reviewed['status'] == 'PRODUCED' and reviewed['review']['recommendation'] == 'KEEP_CANDIDATE' and not decision['selected']:
                        reviewed = {'status': 'ABSTAINED', 'reason': decision['reason']}
                    item.update(effectReview=reviewed, reviewJobId=job['jobId'])
                await self.stage(item, 'review')
            return await self.launch(item, work)

    @staticmethod
    def require_review(item):
        result = item.get('effectReview') or {}
        if item.get('loop') and (item.get('reviewJobId') != item.get('rerunJobId') or result.get('status') != 'PRODUCED' or (result.get('review') or {}).get('recommendation') != 'KEEP_CANDIDATE'):
            raise ValueError('当前候选未通过独立效果审查')

    async def decide(self, identifier, decision):
        await self.get(identifier)
        async with self.reservation():
            item = await asyncio.to_thread(read_json, self.path(identifier))
            if decision not in ('adopt', 'retain', 'cancel'):
                raise ValueError('无效的优化决定')
            if decision == 'cancel':
                # Persist the request so another replica's owner sees it too.
                await asyncio.to_thread(self.path(identifier).with_suffix('.cancel').write_text, now(), encoding='utf-8')
                task = self.active.get(identifier)
                if task:
                    task.cancel()
                elif not await self.busy(identifier):
                    if item.get('loop'):
                        item['loop'].update(status='CANCELLED', reason='用户取消优化', finishedAt=now())
                    await self.stage(item, 'cancelled')
                return item
            if await self.busy(identifier) or item['status'] != 'review':
                raise ValueError('候选尚未完成复测')
            if decision == 'adopt':
                if item.get('proposalOnly') or item.get('holdoutFingerprint') and not item.get('holdoutVerified'):
                    raise ValueError('请先完成独立留出集复核，再决定采纳候选')
                self.require_review(item)
                await self.assert_protocol(item)
            await self.stage(item, 'adopted' if decision == 'adopt' else 'retained')
            return item

    async def close(self):
        self.closing = True
        tasks = list(self.active.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
