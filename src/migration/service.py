"""Migration application controller. HTTP never owns execution or Agent state."""
import asyncio
import base64
from copy import deepcopy
import json
import os
from pathlib import Path
import re
from uuid import uuid4

from agents.criterion import judge_criteria, judge_identity
from agents.migration import run_migration
from api.contracts import parse
from assets.snapshot import execute as snapshot
from assets.store import execute as assets
from runtime.agent_client import AgentRuntimeClient
from runtime.models import configured_model_role, model_timeout_ms
from storage.activity import ActivityStore
from storage.coordination import CoordinationConflict
from storage.repository import TaskRepository, execution_owner
from tasks.values import fingerprint, now

from .control import execute as transition
from .execution_ports import ExecutionPorts
from .facts import current_candidate, session_input_digest, control_inputs, builder_status, input_issues, completed_repetitions, run_configuration_current, scope_digest, development_current, require_binding
from .integrity import approved_plan, candidate_plan_current, basic_report, basic_current, verify_delivery
from .runtime import create_runtime
from .plan_review import review_environment
from .state import MigrationControlError, milliseconds


INSTRUCTIONS = {
    'PREPARE': '调查完整工程、识别 Skill 和工具，准备原工程运行入口及基线条件；保留未确认条件，不执行迁移。',
    'ANALYZE': '调查当前源码和用户目标，形成迁移方案并作为工作产物发布；本次先讨论方案。',
    'GENERATE': '根据用户已确认的目标及方案实施迁移，登记实际交付工具，执行基础验证，发现问题自行修复和复测，再请求独立审查。',
    'REPAIR': '根据所选开发集及工程检查的证据诊断问题，自行决定调整 Skill、工具、工程或运行配置，修复后复测；必要时委派只读调查与独立审查。',
    'OPTIMIZE': '基于选定开发集和用户给定的目标开展优化，按需诊断、调整、复测并请求独立审查；遵守预算。用户已选择新建 Runtime 时先请求准备并在交付后继续同一任务。'}


class MigrationTaskService:
    runtime_features = ['processEvidence', 'streaming', 'packagedMcp', 'externalMcp', 'inlineSecrets', 'multiTurn', 'toolProcessEvidence',
        'mcpResultChannels', 'mcpPrepare', 'otlpEvidence', 'otlpExport', 'projectExecution', 'artifactEvidence', 'caseStateLifecycle']

    def __init__(self, configuration, *, agent=run_migration, judge=judge_criteria, identity=judge_identity, agent_runtime=None, runtime_factory=None):
        self.configuration = configuration
        self.repository = TaskRepository(configuration['dataDirectory'])
        self.activity_store = ActivityStore(configuration['dataDirectory'])
        self.agent, self.judge, self.judge_identity = agent, judge, identity
        self.agent_runtime = agent_runtime or AgentRuntimeClient()
        self.runtime_factory = runtime_factory
        self.operations, self.session_locks = {}, {}
        self.closing, self.recovery = False, None
        self.ports = ExecutionPorts(self)
        from .builder import TaskBuilderService
        self.builder = TaskBuilderService(self)

    async def runtime(self, frozen, configuration, services=(), **options):
        if self.runtime_factory:
            return await self.runtime_factory(frozen, configuration, services, **options)
        return await create_runtime(self.repository.root, frozen, configuration, services,
            managed=self.configuration.get('managedWorkspace', False), **options)

    def control(self, task, attempt_id, action, inputs=None):
        response = transition({'task': task, 'attemptId': attempt_id, 'action': action, 'inputs': inputs or {}})
        task.clear()
        task.update(response['task'])
        return response['value']

    async def synchronize_goal(self, identifier):
        task = await self.repository.get(identifier)
        events = await self.repository.conversation(identifier, 'taskGoalsSince', after=task.get('goalEventSequence', 0))
        if events:
            def update(current):
                self.control(current, '', 'goal_events', {'events': events})
            task = await self.repository.update(identifier, update)
        return task

    def idle(self, task, *, allow_rescore=False, owner_request_id=None, owner_attempt=None):
        if not allow_rescore and self.operations.get(task['id'], {}).get('rescoring'):
            raise MigrationControlError('正在评判或分析已保存证据，请等待或取消')
        if any(item['status'] == 'RUNNING' and item['id'] != owner_attempt for item in task['attempts']):
            raise MigrationControlError('任务正在执行，请等待或取消当前操作')
        if any(item['requirements']['requestId'] != owner_request_id and item.get('automatic', {}).get('status') in ('QUEUED', 'RUNNING') for item in task.get('runtimeBuildRequests', [])):
            raise MigrationControlError('Builder 构建正在执行，请等待或取消')

    async def create(self, value, request_id=None, *, archive=None):
        if archive is None:
            value = parse('create_task', value)
            identifiers = value['sourceAssetIds']
            if len(identifiers) != len(set(identifiers)):
                raise MigrationControlError('不能重复选择同一资产', 400)
            files = {}
            for index, identifier in enumerate(identifiers):
                def read():
                    return assets({'root': self.repository.root, 'action': 'readArchive', 'id': identifier,
                        'legacyOrderIndex': self.configuration['legacyOrderIndex']})
                contents = await asyncio.to_thread(read)
                files.update({'members/member-' + str(index + 1) + '/' + name: content for name, content in contents.items()})
            for name, content in value.get('assets', {}).items():
                if name in files or name.split('/')[-1].lower() == 'skill.md':
                    raise MigrationControlError('依赖文件不能覆盖 Skill 或添加未选择的 Skill', 400)
                if base64.b64encode(base64.b64decode(content, validate=True)).decode() != content:
                    raise MigrationControlError('依赖文件编码无效', 400)
                files[name] = content
        else:
            # The same input contract, with an archive replacing selected IDs.
            value = parse('create_task', {**value, 'sourceAssetIds': ['archive']})
            files = await asyncio.to_thread(snapshot, {'action': 'decode', 'archive': base64.b64encode(archive).decode()})
        if value.get('configuration'):
            self.validate_project_execution(value['inputKind'], value['configuration'])
        source = await asyncio.to_thread(snapshot, {'action': 'snapshot', 'files': files, 'version': 'source', 'project': value['inputKind'] == 'agent_project'})
        defaults = await asyncio.to_thread(snapshot, {'action': 'describe', 'source': source})
        identifier = 'bundle-' + str(uuid4())
        task = {'schemaVersion': 'finance.skill-migration.task.v3', 'id': identifier,
            'name': value['name'] or defaults['name'], 'goal': value['goal'] or defaults['goal'], 'target': value['target'] or defaults['target'],
            **({'configuration': value['configuration']} if value.get('configuration') else {}),
            **({'requestId': request_id} if request_id else {}), 'createdAt': now(), 'source': {key: data for key, data in source.items() if key != 'files'},
            'inputKind': value['inputKind'], 'projectNotes': value['projectNotes'], 'currentCandidateId': None, 'candidates': [], 'attempts': [], 'runs': []}
        await self.repository.save_snapshot(identifier, 'source', source)
        return await self.repository.save(task)

    @staticmethod
    def validate_project_execution(input_kind, configuration):
        if configuration.get('executionMode') != 'agent_project':
            return
        if input_kind != 'agent_project':
            raise MigrationControlError('只有完整 Agent 工程可以选择工程运行方式')
        if configuration.get('entryInstructionsFile') or configuration.get('harnessTools'):
            raise MigrationControlError('工程运行方式使用工程自身的 Agent，不注入 Skill 入口或 Harness 工具')

    async def configure(self, identifier, value, purpose='candidate'):
        configuration = parse('task_configuration', value)
        def update(task):
            self.idle(task)
            if purpose == 'baseline':
                if task.get('inputKind') != 'agent_project':
                    raise MigrationControlError('仅完整工程可配置原工程基线')
                if configuration.get('entryInstructionsFile') or configuration['harnessTools']:
                    raise MigrationControlError('原工程基线不注入 Skill 入口或 Harness 工具')
                task['baselineConfiguration'] = {**configuration, 'executionMode': 'agent_project'}
                return
            self.validate_project_execution(task.get('inputKind'), configuration)
            issues = input_issues(task, configuration)
            if issues:
                raise MigrationControlError('；'.join(issues))
            changed = fingerprint(task.get('configuration')) != fingerprint(configuration)
            task.update(configuration=configuration, configurationConfirmed=True)
            if changed:
                waiting = next((item for item in reversed(task['attempts']) if item['kind'] == 'CHAT' and item['status'] == 'WAITING' and item.get('waitingInteractionIds')), None)
                owner = next((item for item in task['attempts'] if waiting and item['id'] == waiting.get('agentOptimizationOwnerId')), waiting)
                baseline = (owner.get('optimization') or {}).get('workingEvaluationId') or owner.get('optimizationBaselineRunId') if owner else None
                if owner and baseline:
                    change = {'baselineRunId': baseline, 'reference': 'configuration:' + fingerprint(configuration), 'reason': '用户在待答期间明确更新了运行配置',
                        'configurationDigest': fingerprint(configuration), **({'selectionRevision': task['runtimeSelectionRevision']} if 'runtimeSelectionRevision' in task else {}),
                        **({'bindingId': task['runtimeDelivery']['id']} if task.get('selectedRuntimeBuildRequestId') and task.get('runtimeDelivery') else {})}
                    owner['runtimeChange'] = change
                    waiting['runtimeChange'] = change
        return await self.view(await self.repository.update(identifier, update))

    async def save_suite(self, identifier, value):
        from evaluation.packs import suite_cases
        suite = parse('migration_suite', value)
        suite_cases(suite)
        def update(task):
            self.idle(task)
            if any(item['kind'] == 'OPTIMIZE' and item['status'] == 'WAITING' and item.get('optimization', {}).get('waiting') for item in task['attempts']):
                raise MigrationControlError('优化正在等待外部调整；测试集保持冻结，请先停止优化再修改')
            task['suite'] = suite
        return await self.view(await self.repository.update(identifier, update))

    async def start(self, identifier, kind, value, request_id=None):
        parsed = parse('task_operation', value)
        if kind in INSTRUCTIONS:
            if kind == 'PREPARE' and not parsed.get('resumeAttemptId'):
                parsed['prepareProject'] = True
            if kind == 'OPTIMIZE':
                parsed['optimization'] = parse('optimization_goal', parsed.get('optimization') or {})
            parsed['clarification'] = '\n'.join(item for item in [INSTRUCTIONS[kind], json.dumps(parsed['optimization'], ensure_ascii=False) if kind == 'OPTIMIZE' else None, parsed.get('clarification')] if item)
            kind = 'CHAT'
        digest = fingerprint({'kind': kind, 'input': parsed})
        await self.synchronize_goal(identifier)
        current = await self.repository.get(identifier)
        # Resolve an exact idempotent retry even while the original is running.
        for attempt in current['attempts']:
            resume = next((item for item in attempt.get('resumeRequests', []) if item['key'] == parsed['key']), None)
            if attempt['key'] == parsed['key'] or resume:
                if (resume['digest'] if resume else attempt['requestDigest']) != digest:
                    raise MigrationControlError('请求标识已用于其他操作')
                return await self.view(current)
        key = 'task-execution:' + identifier
        token = await self.repository.acquire(key)
        if not token:
            raise CoordinationConflict('该任务正在由其他请求处理')
        scope = execution_owner.set({'root': self.repository.root, 'id': identifier, 'token': token})
        handed_off = False
        try:
            registered = None
            def register(task):
                nonlocal registered
                waiting = next((item for item in task['attempts'] if item['id'] == parsed.get('resumeAttemptId')), {})
                facts = control_inputs(task, self.judge_identity(), session_input_digest(task, waiting.get('runId') or parsed.get('runId')))
                registered = self.control(task, '', 'register', {'input': parsed, 'kind': kind, 'requestDigest': digest,
                    'optimizationGoal': parse('optimization_goal', parsed['optimization']) if kind == 'CHAT' and 'optimization' in parsed else None,
                    'requestId': request_id, 'facts': facts, 'closing': self.closing,
                    'rescoring': self.operations.get(identifier, {}).get('rescoring', False), 'runtimeManaged': kind == 'CHAT',
                    'executing': len(self.operations), 'persisted': True})
            task = await self.repository.update(identifier, register)
            if registered['duplicate']:
                return await self.view(task)
            attempt_id = registered['attemptId']
            async def execute():
                try:
                    await self.activity_store.start(identifier, attempt_id)
                    await self.activity_store.emit(identifier, 'started', '开始执行')
                    await self.ports.run(identifier, attempt_id, parsed['phase'])
                finally:
                    saved = await self.repository.get(identifier)
                    terminal = next(item for item in saved['attempts'] if item['id'] == attempt_id)['status']
                    await self.activity_store.emit(identifier, 'finished', '执行结束', status=terminal)
                    self.operations.pop(identifier, None)
                    await self.repository.release(key, token)
            pending = asyncio.create_task(execute(), name='migration:' + identifier)
            self.operations[identifier] = {'task': pending, 'attemptId': attempt_id}
            handed_off = True
            pending.add_done_callback(self.operation_done)
            return await self.view(task)
        finally:
            execution_owner.reset(scope)
            if not handed_off:
                await self.repository.release(key, token)

    @staticmethod
    def operation_done(pending):
        if not pending.cancelled():
            pending.exception()  # Terminal state is persisted by the application program.

    async def progress(self, identifier, attempt_id, message):
        await self.activity_store.emit(identifier, 'progress', message)
        def update(task):
            next(item for item in task['attempts'] if item['id'] == attempt_id)['message'] = message
        await self.repository.update(identifier, update)

    async def activity(self, identifier, attempt_id, event):
        await self.activity_store.emit(identifier, event['kind'], event['label'], event.get('text'))

    async def reviewer(self, material, identifier, attempt_id):
        from agents.review import review
        return await review(material, identifier, attempt_id, self.repository.root, runtime=self.agent_runtime,
            on_activity=lambda event: self.activity(identifier, attempt_id, event))

    async def dispatch_budget(self, identifier, attempt_id):
        task = await self.repository.get(identifier)
        attempt = next(item for item in task['attempts'] if item['id'] == attempt_id)
        request = attempt.get('budgetContinuation')
        if attempt['status'] != 'COMPLETED' or not request or request['status'] != 'PENDING':
            return
        # Let the outer execution release its ownership before the follow-up
        # is admitted. The durable request is picked up by the recovery loop.
        if identifier in self.operations:
            return
        await self.resume_optimization(identifier, {'key': 'agent-budget-' + attempt_id, 'ownerAttemptId': request['ownerAttemptId'],
            **{key: request[key] for key in ('additionalRounds', 'additionalSeconds') if key in request}})
        def saved(task):
            source = next(item for item in task['attempts'] if item['id'] == attempt_id)
            if source.get('budgetContinuation', {}).get('status') == 'PENDING':
                source['budgetContinuation']['status'] = 'STARTED'
                source['message'] = '预算已更新，正在继续原优化'
        await self.repository.update(identifier, saved)

    async def resume_optimization(self, identifier, value, request_id=None):
        if set(value) - {'key', 'ownerAttemptId', 'additionalRounds', 'additionalSeconds'}:
            raise MigrationControlError('Invalid optimization continuation', 400)
        task = await self.repository.get(identifier)
        previous = next((item for item in task['attempts'] if item['key'] == value['key']), None)
        return await self.start(identifier, 'CHAT', {'key': value['key'], 'baseCandidateId': previous.get('baseCandidateId') if previous else task['currentCandidateId'],
            'resumeOptimizationOwnerId': value['ownerAttemptId'], **({'additionalOptimizationRounds': value['additionalRounds']} if 'additionalRounds' in value else {}),
            **({'additionalOptimizationSeconds': value['additionalSeconds']} if 'additionalSeconds' in value else {})}, request_id)

    async def prepare_runtime(self, identifier, attempt_id, request):
        if self.builder is None:
            raise MigrationControlError('Builder 接入尚未配置', 503)
        return await self.builder.prepare_for_agent(identifier, attempt_id, request)

    async def get(self, identifier):
        return await self.view(await self.synchronize_goal(identifier))

    async def list(self):
        return [await self.get(task['id']) for task in await self.repository.list()]

    async def view(self, task):
        from .presentation import task_view
        return await task_view(self, task)

    async def close(self):
        self.closing = True
        if self.recovery:
            self.recovery.cancel()
            await asyncio.gather(self.recovery, return_exceptions=True)
        pending = [entry['task'] for entry in self.operations.values()]
        for operation in pending:
            operation.cancel()
        await asyncio.gather(*pending, return_exceptions=True)

    async def conversation(self, identifier, after=0, limit=100):
        await self.repository.get(identifier)
        return await self.repository.conversation(identifier, after=after, limit=limit)

    async def answer(self, identifier, value, request_id=None):
        if not isinstance(value, dict) or set(value) != {'key', 'attemptId', 'interactionId', 'answers'} or not isinstance(value['answers'], dict):
            raise MigrationControlError('Invalid conversation answer', 400)
        task = await self.repository.get(identifier)
        attempt = next((item for item in task['attempts'] if item['id'] == value['attemptId']), None)
        if not attempt or attempt['kind'] not in ('CHAT', 'PREPARE', 'ANALYZE', 'GENERATE', 'REPAIR'):
            raise MigrationControlError('等待中的任务不存在')
        duplicate = any(item['key'] == value['key'] for item in attempt.get('resumeRequests', []))
        if not duplicate:
            if attempt['status'] != 'WAITING' or value['interactionId'] not in attempt.get('waitingInteractionIds', []):
                raise MigrationControlError('该问题不再等待回答，请刷新后重试')
            if not value['answers'] or any(not isinstance(answer, str) or not answer.strip() or len(answer) > 16000 for answer in value['answers'].values()):
                raise MigrationControlError('请填写问题的回答', 400)
        return await self.start(identifier, attempt['kind'], {'key': value['key'], 'baseCandidateId': attempt.get('baseCandidateId') if duplicate else task['currentCandidateId'],
            'resumeAttemptId': attempt['id'], 'sessionAnswer': {'interactionId': value['interactionId'], 'answers': value['answers']}}, request_id)

    async def message(self, identifier, value, request_id=None):
        async with self.session_locks.setdefault(identifier, asyncio.Lock()):
            if not isinstance(value, dict) or set(value) - {'key', 'text', 'developmentRunId', 'prepareProject', 'optimization'}:
                raise MigrationControlError('Invalid conversation message', 400)
            text, key = value.get('text'), value.get('key')
            if not isinstance(text, str) or not text.strip() or len(text) > 16000 or not isinstance(key, str) or not 1 <= len(key) <= 100:
                raise MigrationControlError('请填写有效的消息', 400)
            value = {**value, 'text': text.strip()}
            if sum(bool(value.get(field)) for field in ('prepareProject', 'developmentRunId', 'optimization')) > 1:
                raise MigrationControlError('一次消息只能指定一种工作')
            task = await self.repository.get(identifier)
            previous = await self.repository.conversation(identifier, 'getInstruction', key=key, text=value['text'])
            if previous == 'accepted':
                return {'status': 'accepted'}
            if previous in ('sending', 'uncertain'):
                raise MigrationControlError('上次补充要求的接收状态待核对，请勿重复发送')
            discussion = next((item for item in task['attempts'] if item['kind'] == 'CHAT' and item['key'] == key), None)
            if discussion:
                optimization = value.get('optimization') or {}
                if (discussion.get('clarification') != value['text'] or fingerprint(discussion.get('optimizationGoal')) != fingerprint(optimization.get('goal'))
                        or optimization and discussion.get('optimizationBaselineRunId') != optimization.get('runId')
                        or discussion.get('discussionEvidenceRunId') != value.get('developmentRunId') or bool(discussion.get('prepareProject')) != bool(value.get('prepareProject'))):
                    raise MigrationControlError('请求标识已用于其他消息')
                return {'status': 'accepted', 'task': await self.view(task)}
            active = next((item for item in task['attempts'] if item['status'] == 'RUNNING' and item['kind'] in ('CHAT', 'PREPARE', 'ANALYZE', 'GENERATE', 'REPAIR')), None)
            if not active:
                last = (task['attempts'] or [{}])[-1]
                if last.get('status') == 'INTERRUPTED' and last.get('sessionControl'):
                    raise MigrationControlError('原执行的控制状态尚未解除，请先核对并恢复或取消原执行')
                inputs = {'key': key, 'baseCandidateId': task['currentCandidateId'], 'clarification': value['text']}
                if value.get('prepareProject'):
                    inputs['prepareProject'] = True
                if value.get('optimization'):
                    inputs.update(optimization=value['optimization']['goal'], runId=value['optimization']['runId'])
                elif value.get('developmentRunId'):
                    inputs['runId'] = value['developmentRunId']
                return {'status': 'accepted', 'task': await self.start(identifier, 'CHAT', inputs, request_id)}
            if any(value.get(field) for field in ('prepareProject', 'developmentRunId', 'optimization')):
                raise MigrationControlError('任务仍在执行，请先完成或结束当前操作，再指定新的工作')
            if active.get('sessionControl', {}).get('status') == 'PAUSED':
                queued = await self.repository.conversation(identifier, 'queuedInstructions', attemptId=active['id'])
                if previous == 'queued':
                    if any(item['key'] == key for item in queued):
                        return {'status': 'queued', 'task': await self.view(task)}
                    raise MigrationControlError('该补充要求属于另一轮执行，请核对任务记录')
                if len(queued) >= 100:
                    raise MigrationControlError('暂停期间的补充要求已达上限，请先继续执行')
                status = await self.repository.conversation(identifier, 'queueInstruction', key=key, text=value['text'], attemptId=active['id'])
                if status in ('queued', 'accepted'):
                    return {'status': status, 'task': await self.view(await self.repository.get(identifier))}
                raise MigrationControlError('上次补充要求的接收状态待核对，请勿重复发送')
            if active.get('sessionControl'):
                raise MigrationControlError('会话控制状态待确认，请稍后重试')
            if not await self.agent_runtime.ready(identifier, active['id']):
                raise MigrationControlError('Agent 正在准备或已结束，请稍后刷新重试')
            status = await self.repository.conversation(identifier, 'queueInstruction', key=key, text=value['text'])
            if status == 'accepted':
                return {'status': 'accepted'}
            if status != 'queued':
                raise MigrationControlError('上次补充要求的接收状态待核对，请勿重复发送')
            await self.repository.conversation(identifier, 'instructionStatus', key=key, before='queued', after='sending')
            try:
                await self.agent_runtime.instruction(identifier, active['id'], key, value['text'])
            except Exception:
                await self.repository.conversation(identifier, 'instructionStatus', key=key, before='sending', after='uncertain')
                raise MigrationControlError('补充要求的接收状态未确认，请查看任务进展后再操作') from None
            await self.repository.conversation(identifier, 'instructionStatus', key=key, before='sending', after='accepted')
            return {'status': 'accepted'}

    async def control_conversation(self, identifier, action):
        if action not in ('pause', 'resume'):
            raise MigrationControlError('Invalid session control', 400)
        async with self.session_locks.setdefault(identifier, asyncio.Lock()):
            task = await self.synchronize_goal(identifier)
            last = (task['attempts'] or [{}])[-1]
            if action == 'resume' and last.get('status') == 'INTERRUPTED' and last.get('sessionControl') and last.get('sessionExecutionId') and not any(item['status'] == 'RUNNING' for item in task['attempts']):
                paused = await self.repository.conversation(identifier, 'pausedRound', attemptId=last['id'])
                checkpoint = await self.repository.conversation(identifier, 'recoveryRound', attemptId=last['id'])
                resume_paused = bool(paused and paused['status'] == 'paused' and paused['recoverable'])
                if not resume_paused and not (checkpoint and checkpoint['recoverable'] and checkpoint['status'] in ('running', 'finished')):
                    raise MigrationControlError('没有可恢复的检查点，请先核对原任务状态')
                if last.get('sessionInputDigest') != session_input_digest(task, last.get('runId')):
                    raise MigrationControlError('任务目标、工作版本或运行配置已变化，不能继续原执行')
                if await self.agent_runtime.control_state(identifier, last['id']) != 'UNAVAILABLE' or (await self.agent_runtime.execution_status(identifier, last['sessionExecutionId']))['available']:
                    raise MigrationControlError('原执行仍可用或状态未确认，请先重新连接原执行')
                return await self.start(identifier, last['kind'], {'key': str(uuid4()), 'baseCandidateId': task['currentCandidateId'],
                    'resumeAttemptId': last['id'], 'resumePaused' if resume_paused else 'recoverCheckpoint': True})
            result = None
            def requested(task):
                nonlocal result
                result = self.control(task, '', 'control_requested', {'action': action})
            await self.repository.update(identifier, requested)
            attempt_id = result['attemptId'] if isinstance(result, dict) else result
            queued = []
            try:
                if action == 'resume':
                    queued = await self.repository.conversation(identifier, 'queuedInstructions', attemptId=attempt_id)
                if len(queued) > 100:
                    raise MigrationControlError('暂停期间的补充要求过多，请先核对任务记录')
            except Exception:
                await self.repository.update(identifier, lambda task: self.control(task, attempt_id, 'control_not_sent', {'action': action}))
                raise
            claimed = []
            try:
                for item in queued:
                    await self.repository.conversation(identifier, 'instructionStatus', key=item['key'], before='queued', after='sending')
                    claimed.append(item)
            except Exception:
                for item in claimed:
                    await self.repository.conversation(identifier, 'instructionStatus', key=item['key'], before='sending', after='uncertain')
                await self.repository.update(identifier, lambda task: self.control(task, attempt_id, 'control_not_sent', {'action': action}))
                raise
            try:
                accepted = await self.agent_runtime.control(identifier, attempt_id, action, [item['text'] for item in queued])
            except Exception:
                accepted = False
            for item in queued:
                await self.repository.conversation(identifier, 'instructionStatus', key=item['key'], before='sending', after='accepted' if accepted else 'uncertain')
            if accepted and action == 'pause':
                await self.synchronize_goal(identifier)
            updated = await self.repository.update(identifier, lambda task: self.control(task, attempt_id, 'control_ack', {
                'accepted': accepted, 'action': action, 'inputDigest': session_input_digest(task, next(item for item in task['attempts'] if item['id'] == attempt_id).get('runId'))}))
            if not accepted:
                raise MigrationControlError('控制结果尚未确认，请刷新任务并核对 Agent 状态')
            return await self.view(updated)

    async def reconcile_control(self, identifier):
        async with self.session_locks.setdefault(identifier, asyncio.Lock()):
            task = await self.synchronize_goal(identifier)
            active = (task['attempts'] or [{}])[-1]
            if active.get('status') not in ('RUNNING', 'INTERRUPTED') or active.get('kind') not in ('CHAT', 'PREPARE', 'ANALYZE', 'GENERATE', 'REPAIR') or not active.get('sessionControl'):
                return await self.view(task)
            state, observed = 'UNAVAILABLE', {'verified': False}
            try:
                state = await self.agent_runtime.control_state(identifier, active['id'])
                if active['status'] == 'INTERRUPTED' and active.get('sessionExecutionId'):
                    observed.update(available=(await self.agent_runtime.execution_status(identifier, active['sessionExecutionId']))['available'],
                        paused=await self.repository.conversation(identifier, 'pausedRound', attemptId=active['id']),
                        round=await self.repository.conversation(identifier, 'recoveryRound', attemptId=active['id']), verified=True)
            except Exception:
                state = 'UNAVAILABLE'
            updated = await self.repository.update(identifier, lambda task: self.control(task, active['id'], 'reconcile_control', {
                **observed, 'state': state, 'inputDigest': session_input_digest(task, active.get('runId'))}))
            return await self.view(updated)

    async def cancel(self, identifier):
        current = await self.get(identifier)
        last = (current['attempts'] or [{}])[-1]
        if last.get('status') == 'INTERRUPTED' and last.get('sessionControl') and last.get('sessionExecutionId'):
            paused = await self.repository.conversation(identifier, 'pausedRound', attemptId=last['id'])
            if not paused or paused['status'] != 'paused':
                raise MigrationControlError('原执行的状态尚未确认，不能自动取消或重放，请先核对运行状态')
            if await self.agent_runtime.control_state(identifier, last['id']) != 'UNAVAILABLE' or (await self.agent_runtime.execution_status(identifier, last['sessionExecutionId']))['available']:
                raise MigrationControlError('原执行仍可用或状态未确认，请先核对，避免误取消')
            await self.repository.conversation(identifier, 'cancelPausedRound', attemptId=last['id'])
            def saved(task):
                attempt = next(item for item in task['attempts'] if item['id'] == last['id'])
                attempt.update(status='CANCELLED', finishedAt=now(), message='已取消暂停的执行，工作和对话已保留')
                attempt.pop('sessionControl', None)
                attempt.pop('sessionResumePaused', None)
            return await self.view(await self.repository.update(identifier, saved))
        active = next((item for item in current['attempts'] if item['status'] == 'RUNNING' and item.get('agentEvaluation') != 'RUNNING'
            and item.get('agentReview') != 'RUNNING' and not item.get('runtimeWait') and item['kind'] in ('CHAT', 'PREPARE', 'ANALYZE', 'GENERATE', 'REPAIR')), None)
        if active:
            # Never cancel the local waiter on an unconfirmed remote stop.
            try:
                ready = await self.agent_runtime.ready(identifier, active['id'])
            except Exception:
                raise MigrationControlError('无法联系 Agent 运行服务，尚不能确认任务已停止', 503) from None
            if not ready:
                raise MigrationControlError('Agent 正在准备或状态发生变化，请刷新后重试')
            if not await self.agent_runtime.cancel(identifier, active['id']):
                raise MigrationControlError('未能确认 Agent 已停止，请检查任务状态后重试', 503)
        operation = self.operations.get(identifier)
        if operation:
            operation['task'].cancel()
            await asyncio.gather(operation['task'], return_exceptions=True)
        await self.repository.update(identifier, lambda task: self.control(task, '', 'cancel_waiting'))
        return await self.get(identifier)

    async def initialize(self):
        # Never mark another replica's live work interrupted.
        for task in await self.repository.list():
            try:
                async with self.repository.ownership(task['id']):
                    def recover(current):
                        last = (current['attempts'] or [{}])[-1]
                        self.control(current, '', 'startup', {'inputDigest': session_input_digest(current, last.get('runId'))})
                    await self.repository.update(task['id'], recover)
            except CoordinationConflict:
                pass
        self.recovery = asyncio.create_task(self.recover_loop(), name='migration-recovery')

    async def recover_loop(self):
        while not self.closing:
            try:
                for task in await self.repository.list():
                    if task['id'] in self.operations:
                        continue
                    for attempt in task['attempts']:
                        if attempt['status'] == 'COMPLETED' and attempt.get('budgetContinuation', {}).get('status') == 'PENDING':
                            await self.dispatch_budget(task['id'], attempt['id'])
                    if task['id'] not in self.operations:
                        for request in task.get('runtimeBuildRequests', []):
                            if task['id'] in self.operations:
                                break
                            automatic = request.get('automatic') or {}
                            if automatic.get('status') == 'SUCCEEDED':
                                if next((item for item in task['attempts'] if item['id'] == request.get('optimizationAttemptId')
                                        and item['status'] == 'WAITING' and item.get('runtimeWait', {}).get('requestId') == request['requirements']['requestId']), None):
                                    await self.builder.start(task['id'], {'requestId': request['requirements']['requestId'], 'trustReference': automatic['trustReference']})
                                else:
                                    await self.builder.resume_basic(task['id'], request['requirements']['requestId'])
                            elif automatic.get('status') == 'INTERRUPTED' and automatic.get('trustReference') and not request['requirements'].get('rebuild') and request['requirements']['requestId'] == task.get('selectedRuntimeBuildRequestId'):
                                await self.builder.start(task['id'], {'requestId': request['requirements']['requestId'], 'trustReference': automatic['trustReference']})
                    if task['id'] not in self.operations:
                        await self.recover_session(task['id'])
            except asyncio.CancelledError:
                raise
            except Exception:
                # An unreachable Runtime does not prove the old execution died.
                # The durable task remains recoverable on the next observation.
                pass
            await asyncio.sleep(5)

    async def recover_session(self, identifier):
        task = await self.repository.get(identifier)
        last = (task['attempts'] or [{}])[-1]
        if self.closing or not last.get('sessionExecutionId') or not self.control(task, last['id'], 'recovery_eligible', {
                'inputDigest': session_input_digest(task, last.get('runId'))}):
            return
        key = 'task-execution:' + identifier
        token = await self.repository.acquire(key)
        if not token:
            return
        scope = execution_owner.set({'root': self.repository.root, 'id': identifier, 'token': token})
        async def recover():
            try:
                await self.ports.run(identifier, last['id'], recover=True)
            finally:
                self.operations.pop(identifier, None)
                await self.repository.release(key, token)
        try:
            pending = asyncio.create_task(recover(), name='migration-recovery:' + identifier)
            self.operations[identifier] = {'task': pending, 'attemptId': last['id']}
            pending.add_done_callback(self.operation_done)
        finally:
            execution_owner.reset(scope)

    async def approve_plan(self, identifier, value):
        if not isinstance(value, dict) or set(value) != {'analysisDigest'} or not re.fullmatch('[a-f0-9]{64}', value.get('analysisDigest', '')):
            raise MigrationControlError('Invalid plan approval', 400)
        def update(task):
            self.idle(task)
            if any(item['kind'] == 'OPTIMIZE' and item['status'] == 'WAITING' and item.get('optimization', {}).get('waiting') for item in task['attempts']):
                raise MigrationControlError('优化正在等待外部调整；修改方案前请先停止优化')
            if not task.get('analysis') or fingerprint(task['analysis']) != value['analysisDigest']:
                raise MigrationControlError('方案已变化，请刷新后重新确认')
            if task['analysis']['missing'] or (task['analysis'].get('plan') or {}).get('unresolvedQuestions'):
                raise MigrationControlError('请先补充方案中的待确认事项')
            revision = next((item for item in task.get('planRevisions', []) if item['id'] == task.get('planRevisionId')), None)
            if revision is None:
                revision = {'id': 'plan-' + str(uuid4()), 'digest': value['analysisDigest'], 'analysis': deepcopy(task['analysis']),
                    'baseCandidateId': task['currentCandidateId'], 'createdAt': now()}
                task.setdefault('planRevisions', []).append(revision)
                task['planRevisionId'] = revision['id']
                candidate = current_candidate(task)
                if candidate and not candidate.get('planRevisionId'):
                    candidate['planRevisionId'] = revision['id']
            if revision['digest'] != value['analysisDigest']:
                raise MigrationControlError('方案版本不一致，请重新分析后确认')
            revision['approvedAt'] = now()
        return await self.view(await self.repository.update(identifier, update))

    async def review_runtime(self, identifier):
        task = await self.get(identifier)
        candidate = current_candidate(task)
        if not candidate or not task.get('configuration') or not candidate_plan_current(task):
            raise MigrationControlError('请先确认方案、生成当前结果并选择运行环境')
        opened = await self.runtime(await self.repository.read_snapshot(identifier, candidate['id']), task['configuration'], candidate.get('services', []))
        require_binding(task, opened['environmentSnapshot'])
        review = review_environment(task, opened['environmentSnapshot'])
        def update(current):
            self.idle(current)
            if current['currentCandidateId'] != candidate['id'] or fingerprint(current.get('configuration')) != fingerprint(task['configuration']) or fingerprint(current.get('analysis')) != fingerprint(task.get('analysis')) or current.get('runtimeSelectionRevision') != task.get('runtimeSelectionRevision'):
                raise MigrationControlError('方案、结果或环境配置已变化，请重新核对')
            current['runtimeReview'] = review
        return await self.view(await self.repository.update(identifier, update))

    async def check_runtime(self, identifier, owner_request_id=None, owner_attempt=None):
        from .facts import require_binding
        async with self.repository.ownership(identifier):
            task = await self.get(identifier)
            candidate = current_candidate(task)
            if not candidate or not task.get('configuration'):
                raise MigrationControlError('请先生成候选并配置运行环境')
            if not candidate_plan_current(task):
                raise MigrationControlError('当前结果对应旧方案，请确认并生成最新方案')
            issues = input_issues(task, task['configuration'], True)
            if issues:
                raise MigrationControlError('；'.join(issues) + '。请在准备运行环境中补充，尚不能进行运行验证。')
            require_binding(task)
            check_id = str(uuid4())
            def register(current):
                self.idle(current, owner_request_id=owner_request_id, owner_attempt=owner_attempt)
                if current['currentCandidateId'] != candidate['id'] or fingerprint(current.get('configuration')) != fingerprint(task['configuration']):
                    raise MigrationControlError('候选或运行配置已变化，请刷新后重试')
                current['startupCheck'] = {'id': check_id, 'candidateId': candidate['id'], 'configurationDigest': fingerprint(task['configuration']),
                    **({'runtimeSelectionRevision': task['runtimeSelectionRevision']} if 'runtimeSelectionRevision' in task else {}),
                    **({'builderBindingId': task['runtimeDelivery']['id']} if task.get('selectedRuntimeBuildRequestId') else {}),
                    'status': 'RUNNING', 'startedAt': now(), 'message': '正在启动并检查实例'}
            await self.repository.update(identifier, register)
            try:
                async with asyncio.timeout(60):
                    opened = await self.runtime(await self.repository.read_snapshot(identifier, candidate['id']), task['configuration'], candidate.get('services', []))
                    try:
                        require_binding(task, opened['environmentSnapshot'])
                        review = review_environment(task, opened['environmentSnapshot'])
                        def reviewed(current):
                            if current['startupCheck']['id'] == check_id:
                                current['runtimeReview'] = review
                        await self.repository.update(identifier, reviewed)
                        if review['status'] == 'FAILED':
                            raise MigrationControlError('运行环境不满足迁移方案要求，请查看环境核对结果')
                        await opened['runtime'].prepare({'runId': 'startup-' + check_id})
                    finally:
                        await opened['runtime'].cleanup()
                def passed(current):
                    if current['startupCheck']['id'] == check_id:
                        current['startupCheck'].update(status='PASSED', finishedAt=now(), runtime=opened['environmentSnapshot'],
                            finalization=opened['runtime'].finalization_evidence(), message='全部 Skill 已完成启动检查并释放实例；业务结果由联合验收核验')
                await self.repository.update(identifier, passed)
                return {'status': 'PASSED', 'scope': 'INSTANCE_START_AND_RELEASE',
                    'message': '全部 Skill 已完成启动检查并释放实例；业务结果由联合验收核验', 'runtime': opened['environmentSnapshot']}
            except BaseException as error:
                def failed(current):
                    if current.get('startupCheck', {}).get('id') == check_id:
                        current['startupCheck'].update(status='INTERRUPTED' if isinstance(error, asyncio.CancelledError) else 'FAILED', message='启动检查失败，请检查环境配置后重试')
                await self.repository.update(identifier, failed)
                raise

    async def select_optimization(self, identifier, value):
        if not isinstance(value, dict) or set(value) != {'attemptId'}:
            raise MigrationControlError('Invalid optimization selection', 400)
        def update(task):
            self.idle(task)
            self.control(task, value['attemptId'], 'select_recommended', {'facts': control_inputs(task, self.judge_identity())})
        return await self.view(await self.repository.update(identifier, update))

    async def file(self, identifier, revision, name):
        frozen = await self.repository.read_snapshot(identifier, revision)
        if name not in frozen['files']:
            raise FileNotFoundError(name)
        return {'path': name, 'content': base64.b64decode(frozen['files'][name]).decode('utf-8', errors='replace')}

    async def rescore(self, identifier, value):
        from .rescoring import rescore_task
        request = parse('rescore_request', value)
        async with self.repository.ownership(identifier):
            task = await self.repository.get(identifier)
            self.idle(task)
            result = await rescore_task(self, task, request)
            def update(current):
                self.idle(current)
                source = next((run for run in current['runs'] if run['id'] == result['sourceRunId']), None)
                if not source or fingerprint(source) != result['sourceDigest']:
                    raise MigrationControlError('原始运行记录已变化')
                current.setdefault('rescorings', []).append(result)
            return await self.view(await self.repository.update(identifier, update))

    async def start_rescore(self, identifier, value):
        from .rescoring import rescore_task
        request = parse('rescore_request', value)
        if self.closing:
            raise MigrationControlError('服务正在关闭', 503)
        key = 'task-execution:' + identifier
        token = await self.repository.acquire(key)
        if not token:
            raise CoordinationConflict('该任务正在由其他请求处理')
        scope = execution_owner.set({'root': self.repository.root, 'id': identifier, 'token': token})
        handed_off = False
        operation_id = 'rescore-op-' + str(uuid4())
        try:
            def register(task):
                self.idle(task, allow_rescore=True)
                source = next((run for run in task['runs'] if run['id'] == request['runId']), None)
                if not source or source['status'] == 'RUNNING':
                    raise MigrationControlError('请选择已完成的运行记录')
                if task.get('rescoringOperation', {}).get('status') == 'RUNNING':
                    raise MigrationControlError('正在重新评判')
                task['rescoringOperation'] = {'id': operation_id, 'sourceRunId': request['runId'], 'status': 'RUNNING', 'startedAt': now()}
            reserved = await self.repository.update(identifier, register)
            async def execute():
                try:
                    result = await rescore_task(self, await self.repository.get(identifier), request)
                    def save(task):
                        source = next((run for run in task['runs'] if run['id'] == result['sourceRunId']), None)
                        if not source or fingerprint(source) != result['sourceDigest'] or task.get('rescoringOperation', {}).get('id') != operation_id:
                            raise MigrationControlError('原始运行记录或重新评判状态已变化')
                        task.setdefault('rescorings', []).append(result)
                        task['rescoringOperation'].update(status='COMPLETED', finishedAt=now(), recordId=result['id'])
                    await self.repository.update(identifier, save)
                except BaseException as error:
                    def failed(task):
                        if task.get('rescoringOperation', {}).get('id') == operation_id:
                            status = ('INTERRUPTED' if self.closing else 'CANCELLED') if isinstance(error, asyncio.CancelledError) else 'FAILED'
                            message = {'CANCELLED': '重新评判已取消；原始运行记录仍然保留。', 'INTERRUPTED': '服务关闭，重新评判已中断；原始运行记录仍然保留。',
                                'FAILED': '重新评判未完成，请检查评判服务后重试；原始运行记录仍然保留。'}[status]
                            task['rescoringOperation'].update(status=status, finishedAt=now(), error=message)
                    await self.repository.update(identifier, failed)
                    if isinstance(error, asyncio.CancelledError):
                        raise
                finally:
                    self.operations.pop(identifier, None)
                    await self.repository.release(key, token)
            pending = asyncio.create_task(execute(), name='migration-rescore:' + identifier)
            self.operations[identifier] = {'task': pending, 'rescoring': True}
            pending.add_done_callback(self.operation_done)
            handed_off = True
            return await self.view(reserved)
        finally:
            execution_owner.reset(scope)
            if not handed_off:
                await self.repository.release(key, token)

    async def analyze_run(self, identifier, value):
        if not isinstance(value, dict) or set(value) != {'runId'} or not isinstance(value['runId'], str) or not value['runId']:
            raise MigrationControlError('Invalid diagnosis request', 400)
        run_id = value['runId']
        response = await self.message(identifier, {'key': str(uuid4()), 'developmentRunId': run_id,
            'text': f'请分析开发集运行 {run_id} 的结果，查询实际工程与运行证据，区分 Skill、工具、工程、Runtime 和评测问题；复杂问题可委派只读调查子 Agent。将有依据的诊断及建议发布为工作产物，本次先分析，不修改代码或发起复测。'})
        return response.get('task') or await self.get(identifier)
