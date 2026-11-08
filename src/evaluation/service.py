"""Durable fixed comparison jobs over the shared Python evaluation capabilities."""
import asyncio
from copy import deepcopy
import json
import re
from uuid import uuid4

from assets.library import AssetLibrary
from api.contracts import parse
from evaluation.case_generation import generate_cases
from evaluation.configuration import run_configuration
from evaluation.packs import EvalPackCatalog, PreparationStore
from evaluation.job_control import execute as control, pack_inputs, resolve_pack, TERMINAL
from evaluation.job_execution import run
from evaluation.comparison import evaluate_suite
from evaluation.checks import comparison_incomplete
from evaluation.launcher_execution import execute_launchers
from evaluation.reporting import build_report
from evaluation.scoring import judge_for, evaluate_comparison
from runtime.comparison import comparison_runtimes
from runtime.environments import EnvironmentStore
from runtime.models import configured_model_role
from storage.jobs import JobStore
from storage.coordination import execute as coordinate, CoordinationConflict
from tasks.application_host import run_program
from tasks.values import fingerprint, now


class EvaluationRunService:
    def __init__(self, workspace, *, runtime_factory=comparison_runtimes, judge_factory=judge_for):
        self.workspace = workspace
        self.jobs = JobStore(workspace['dataDirectory'])
        self.library = AssetLibrary(workspace)
        self.environments = EnvironmentStore(workspace['dataDirectory'], workspace.get('launcherTrust'))
        self.catalog = EvalPackCatalog(workspace['rootDirectory'])
        self.preparations = PreparationStore(workspace['dataDirectory'])
        self.runtime_factory, self.judge_factory = runtime_factory, judge_factory
        self.active, self.rescoring = {}, {}
        self.closing, self.scheduler = False, None

    async def initialize(self):
        await asyncio.to_thread(self.jobs.initialize)
        self.scheduler = asyncio.create_task(self.pump(), name='comparison-scheduler')

    async def get(self, identifier):
        value = await asyncio.to_thread(self.jobs.get, identifier)
        if not value:
            raise FileNotFoundError('Evaluation run not found')
        return value

    async def list(self, limit=50):
        return await asyncio.to_thread(self.jobs.list, limit)

    async def save(self, value):
        return await asyncio.to_thread(self.jobs.save, value)

    async def resolve_pack(self, configuration):
        pack = await asyncio.to_thread(self.catalog.get, configuration['packId']) if configuration.get('packId') else None
        if configuration.get('preparationId'):
            preparation = await asyncio.to_thread(self.preparations.get, configuration['preparationId'])
            if not preparation:
                raise ValueError('Unknown prepared evaluation')
            defaults = {role: configured_model_role(role)['model'] for role in ('ANALYZER', 'EXECUTION', 'JUDGE')}
            pack = self.preparations.build_pack(preparation, defaults['ANALYZER'], defaults['EXECUTION'], defaults['JUDGE'])
        if pack is None:
            raise ValueError('评测题集不可用')
        required = pack_inputs(configuration, pack)
        assets = {side: await self.library.call('get', id=identifier) for side, identifier in required.items()}
        defaults = {}
        if configuration['runtime']['type'] == 'direct_model' and not configuration.get('executionModel'):
            defaults['execution'] = configured_model_role('EXECUTION')['model']
        if configuration['judgeMode'] == 'model' and not configuration.get('judgeModel'):
            defaults['judge'] = configured_model_role('JUDGE')['model']
        return resolve_pack({'configuration': configuration, 'pack': pack, 'assets': assets, 'defaults': defaults})

    async def create(self, value, question_set=None):
        configuration = run_configuration(value)
        for identifier in control({'action': 'environment_ids', 'inputs': {'configuration': configuration}}):
            await self.environments.require_available(identifier)
        if self.workspace.get('managedWorkspace') and any(configuration.get(field) for field in ('runtimeToolConfig', 'runtimeCommandBindings', 'runtimeMcpBindings', 'originalService', 'runtimeHarnessTools')):
            raise ValueError('托管工作区只允许已准入的运行配置')
        job = control({'action': 'create', 'inputs': {'configuration': configuration, 'closing': self.closing, 'questionSet': question_set}})['job']
        await self.resolve_pack(configuration)
        return await self.save(job)

    async def retry(self, identifier):
        value = control({'action': 'retry', 'job': await self.get(identifier)})
        return await self.create(value['configuration'], value.get('questionSet'))

    async def cancel(self, identifier):
        job = control({'action': 'cancel', 'job': await self.get(identifier)})['job']
        saved = await self.save(job)
        operation = self.active.get(identifier) or self.rescoring.get(identifier)
        if operation:
            operation.cancel()
        return saved

    async def acquire(self, key, root=None):
        return await asyncio.to_thread(coordinate, {'root': root or self.workspace['dataDirectory'], 'key': key, 'action': 'acquire'})

    async def release(self, key, token, root=None):
        await asyncio.to_thread(coordinate, {'root': root or self.workspace['dataDirectory'], 'key': key, 'action': 'release', 'token': token})

    async def pump(self):
        while not self.closing:
            for job in await self.list(200):
                if self.closing or len(self.active) >= self.workspace['maxConcurrentRuns']:
                    break
                identifier = job['jobId']
                if job['status'] != 'queued' or identifier in self.active:
                    continue
                key = 'comparison-execution:' + identifier
                token = await self.acquire(key)
                if not token:
                    continue
                slot, slot_token = None, None
                for index in range(self.workspace['maxConcurrentRuns']):
                    slot = 'comparison-slot:' + str(index)
                    slot_token = await self.acquire(slot, self.workspace['coordinationDirectory'])
                    if slot_token:
                        break
                if not slot_token:
                    await self.release(key, token)
                    break
                if (await self.get(identifier))['status'] != 'queued':
                    await self.release(slot, slot_token, self.workspace['coordinationDirectory'])
                    await self.release(key, token)
                    continue
                async def execute(identifier=identifier, key=key, token=token, slot=slot, slot_token=slot_token):
                    try:
                        await self.execute(await self.get(identifier))
                    finally:
                        self.active.pop(identifier, None)
                        await self.release(slot, slot_token, self.workspace['coordinationDirectory'])
                        await self.release(key, token)
                operation = asyncio.create_task(execute(), name='comparison:' + identifier)
                self.active[identifier] = operation
                operation.add_done_callback(lambda task: task.exception() if not task.cancelled() else None)
            await asyncio.sleep(.25)

    async def questions(self, configuration, pack, identifier):
        analyzer = configured_model_role('ANALYZER')
        source = await self.library.resolve(pack['variants']['right'], configuration.get('skillAssetId'))
        if source is None:
            raise ValueError('动态出题需要已上传的目标 Skill')
        remaining, references = 28000, {}
        for name, content in sorted(source['files'].items()):
            if not re.match(r'^(references|templates)/.*\.md$', name) or re.search(r'evals?/|holdout|sealed|labels', name, re.I) or remaining <= 0:
                continue
            references[name] = content[:min(remaining, 10000)]
            remaining -= len(references[name])
        metadata = pack.get('metadata', {})
        scenario = json.loads(metadata['generationContext']) if metadata.get('generationContext') else {}
        generated = await generate_cases({'skillId': pack['targetSkillId'], 'skillSource': json.dumps({'instructions': source['instructions'][:32000], 'references': references}, ensure_ascii=False),
            'domainContext': json.dumps({key: metadata.get(key) for key in ('domain', 'dataMode', 'generationContext')}, ensure_ascii=False),
            'count': configuration['generatedCaseCount'], 'existingPrompts': [case['prompt'] for case in pack['cases']],
            'caseDesignContext': {'allowedTools': list(dict.fromkeys(tool for case in pack['cases'] for tool in case['requiredTools'])),
                'supportedTaskModes': ['single_turn'], 'querySubjectRefs': scenario.get('querySubjectRefs', []),
                'seedTasks': [{'name': case['name'], 'prompt': case['prompt'] if case['requiredTools'] and not metadata.get('generationContext') else '', 'requiredTools': case['requiredTools']} for case in pack['cases']]}})
        return {'source': 'ai_generated', 'summary': generated['summary'], 'cases': generated['cases'], 'fingerprint': fingerprint(generated['cases']),
            'generatedAt': now(), 'generationId': identifier, 'model': analyzer['model'], 'skillArtifactSha256': source['artifactSha256'], 'sourceFiles': ['SKILL.md', *references]}

    async def execute(self, job):
        identifier, judge = job['jobId'], None
        async def handle(name, inputs):
            nonlocal judge
            if name == 'load_job':
                return await self.get(identifier)
            if name == 'save_job':
                return await self.save(inputs['job'])
            if name == 'resolve_pack':
                return await self.resolve_pack(inputs['configuration'])
            if name == 'generate_questions':
                return await self.questions(inputs['configuration'], inputs['pack'], identifier)
            if name == 'execute_once':
                if judge is None:
                    judge = await self.judge_factory(inputs['job']['configuration'], inputs['pack'], self.workspace)
                report, latest = await self.execute_once(inputs['job'], inputs['pack'], inputs['iteration'], judge)
                return {'job': latest, 'report': report, 'incomplete': comparison_incomplete(report)}
            raise ValueError('Unknown evaluation capability')
        names = ('load_job', 'save_job', 'resolve_pack', 'generate_questions', 'execute_once')
        await run_program(run({'job': job}), {name: (lambda inputs, name=name: handle(name, inputs)) for name in names})

    async def execute_once(self, job, pack, iteration, judge):
        identifier = job['jobId']
        owners = await self.runtime_factory(job['configuration'], pack, self.workspace)
        finalization, events, pending_flush = None, [], None
        flush_lock = asyncio.Lock()
        async def flush():
            async with flush_lock:
                if not events:
                    return
                batch = events[:]
                events.clear()
                current = control({'action': 'progress', 'job': await self.get(identifier), 'inputs': {'events': batch, 'iteration': iteration}})['job']
                await self.save(current)
        async def delayed_flush():
            await asyncio.sleep(.15)
            await flush()
        async def emit(event):
            nonlocal finalization, pending_flush
            if event.get('progress'):
                events.append(event['progress'])
                if pending_flush is None or pending_flush.done():
                    if pending_flush is not None:
                        pending_flush.result()
                    pending_flush = asyncio.create_task(delayed_flush())
            if event.get('finalization'):
                finalization = {'jobId': identifier, **event['finalization']}
                await flush()
                latest = await self.get(identifier)
                latest['finalization'] = finalization
                if latest.get('cancellation'):
                    latest['cancellation']['workerSettledAt'] = now()
                await self.save(latest)
        async def execute_cases(inputs):
            evidence = await execute_launchers({'runId': inputs['runId'], 'pack': pack, 'launchers': owners}, emit, factory=lambda value: value)
            if job['configuration']['evaluationMode'] == 'candidate_assessment':
                for sides in evidence.values():
                    candidate = deepcopy(sides['right'])
                    candidate['side'] = 'left'
                    candidate.setdefault('metadata', {}).update(candidateAssessmentReused=True, candidateAssessmentSourceSide='right')
                    sides['left'] = candidate
            return evidence
        async def progress(inputs):
            events.append(inputs)
            await flush()
        async def final(_inputs):
            await flush()
        async def score(inputs):
            return await evaluate_comparison(inputs['evalCase'], inputs['left'], inputs['right'], judge, pack['judgeProfile'])
        async def report(inputs):
            return build_report(pack, inputs['cases'], ' | '.join(owner.adapter_id for owner in owners.values()), judge.judge_id, inputs['reportId'], finalization)
        try:
            result = await evaluate_suite(pack, {'prepare': lambda _: None, 'execute_cases': execute_cases, 'cleanup': lambda _: None,
                'evaluate_case': score, 'report': report, 'progress': progress, 'finalization': final})
            return result, await self.get(identifier)
        finally:
            if pending_flush:
                await asyncio.gather(pending_flush, return_exceptions=False)
            await flush()

    async def close(self):
        self.closing = True
        if self.scheduler:
            self.scheduler.cancel()
            await asyncio.gather(self.scheduler, return_exceptions=True)
        operations = list(self.active.values()) + list(self.rescoring.values())
        for operation in operations:
            operation.cancel()
        await asyncio.gather(*operations, return_exceptions=True)

    async def _rescore(self, identifier, request):
        import os
        from evaluation.rescoring import run as rescore_program
        source = control({'action': 'rescore_admit', 'job': await self.get(identifier), 'inputs': {'closing': self.closing, 'busy': False}})['job']
        judge = await self.judge_factory(source['configuration'], source['evaluationSpec'], self.workspace)
        async def info(_):
            return {'judgeId': judge.judge_id, 'supportsPresentationOrder': getattr(judge, 'mode', None) == 'pairwise',
                'configurationDigest': fingerprint({'model': source['configuration'].get('judgeModel') or configured_model_role('JUDGE')['model'],
                    'profile': source['evaluationSpec']['judgeProfile'], 'endpointDigest': fingerprint(os.getenv('FINANCE_EVAL_JUDGE_BASE_URL', os.getenv('FINANCE_EVAL_MODEL_BASE_URL', '')))})}
        async def assess(inputs):
            return await evaluate_comparison(inputs['evalCase'], inputs['original']['left'], inputs['original']['right'], judge,
                source['evaluationSpec']['judgeProfile'], None if inputs['order'] == 'default' else inputs['order'])
        async def commit(inputs):
            current = control({'action': 'rescore_commit', 'job': await self.get(identifier), 'inputs': {'record': inputs['record']}})['job']
            await self.save(current)
        return await run_program(rescore_program({'source': source, 'request': request}), {'judge_info': info, 'judge_case': assess, 'commit_rescore': commit})

    @staticmethod
    def rescore_request(value):
        if not isinstance(value, dict) or set(value) - {'repetitions', 'alternateOrder'}:
            raise ValueError('Invalid rescore request')
        count = value.get('repetitions', 1)
        if type(count) is not int or not 1 <= count <= 5 or type(value.get('alternateOrder', False)) is not bool:
            raise ValueError('Invalid rescore repetitions or presentation order')
        return {'repetitions': count, 'alternateOrder': value.get('alternateOrder', False)}

    async def rescore(self, identifier, value):
        request = self.rescore_request(value)
        key = 'comparison-execution:' + identifier
        token = await self.acquire(key)
        if not token:
            raise CoordinationConflict('正在执行或重新评判')
        operation = asyncio.current_task()
        self.rescoring[identifier] = operation
        try:
            return await self._rescore(identifier, request)
        finally:
            self.rescoring.pop(identifier, None)
            await self.release(key, token)

    async def start_rescore(self, identifier, value):
        request = self.rescore_request(value)
        key = 'comparison-execution:' + identifier
        token = await self.acquire(key)
        if not token:
            raise CoordinationConflict('正在执行或重新评判')
        try:
            current = control({'action': 'rescore_start', 'job': await self.get(identifier), 'inputs': {'closing': self.closing, 'busy': False}})['job']
            await self.save(current)
        except BaseException:
            await self.release(key, token)
            raise
        operation = current['rescoringOperation']
        async def execute():
            record, error = None, None
            try:
                record = await self._rescore(identifier, request)
            except BaseException as failure:
                error = '重新评判已中断；原始执行记录仍然保留。' if isinstance(failure, asyncio.CancelledError) else '重新评判未完成，请检查模型连接后重试。'
            finally:
                try:
                    updated = control({'action': 'rescore_finished', 'job': await self.get(identifier), 'inputs': {
                        'operationId': operation['id'], 'recordId': record['id'] if record else None, 'error': error}})['job']
                    await self.save(updated)
                finally:
                    self.rescoring.pop(identifier, None)
                    await self.release(key, token)
        pending = asyncio.create_task(execute(), name='comparison-rescore:' + identifier)
        self.rescoring[identifier] = pending
        pending.add_done_callback(lambda task: task.exception() if not task.cancelled() else None)
        return operation
