"""Builder requests and task binding; Builder itself remains an external service."""
import asyncio
import base64
from copy import deepcopy
import json
import os
from uuid import uuid4

from api.contracts import parse
from assets.export import assert_safe
from assets.runtime_skills import from_files, stats
from runtime.builder_client import BuilderClient
from runtime.environments import EnvironmentStore
from tasks.values import fingerprint, now
from .facts import current_candidate, builder_status, control_inputs, session_input_digest, suite_digest, require_binding
from .integrity import candidate_plan_current
from .runtime import runtime_inputs
from .state import MigrationControlError


def idle(task, owner=None, request_id=None):
    if any(item['status'] == 'RUNNING' and item['id'] != owner for item in task['attempts']):
        raise MigrationControlError('任务正在执行，请等待或取消当前操作')
    if any(item['requirements']['requestId'] != request_id and item.get('automatic', {}).get('status') in ('QUEUED', 'RUNNING') for item in task.get('runtimeBuildRequests', [])):
        raise MigrationControlError('Builder 构建正在执行，请等待或取消')


def owned_optimization(task, owner=None):
    return next((item for item in task['attempts'] if (item['id'] == owner if owner else item['kind'] == 'OPTIMIZE')
        and item['status'] in ('RUNNING', 'WAITING') and (item['kind'] == 'CHAT' and item.get('runtimeWait')
            or item['kind'] == 'OPTIMIZE' and item.get('optimization', {}).get('status') == 'WAITING' and item['optimization'].get('waiting'))), None)


class TaskBuilderService:
    def __init__(self, service, registry=None):
        self.service, self.repository = service, service.repository
        self.registry = registry or EnvironmentStore(self.repository.root, service.configuration.get('launcherTrust'))

    async def request(self, identifier, value, owner=None):
        value = parse('task_build_input', value)
        if value.get('executionMode') == 'agent_project':
            raise MigrationControlError('完整工程运行请接入支持工程执行的现有 Runtime；Builder 用于构建新的 Skill Runtime')
        async def update(task):
            idle(task, owner)
            optimization = owned_optimization(task, owner)
            waiting = (optimization.get('optimization') or {}).get('waiting') if optimization else None
            if owner and not optimization:
                raise MigrationControlError('构建操作不属于当前优化轮次')
            if waiting:
                self.service.control(task, optimization['id'], 'assert_optimization_inputs', {'facts': control_inputs(task)})
                if waiting['kind'] != 'BUILDER':
                    raise MigrationControlError('本轮等待的不是 Builder 调整')
            candidate = next((item for item in task['candidates'] if item['id'] == waiting['candidate']['id']), None) if waiting else current_candidate(task)
            if not candidate or candidate['id'] != value['baseCandidateId']:
                raise MigrationControlError('候选已变化，请刷新后导出需求')
            if not candidate_plan_current(task):
                raise MigrationControlError('当前结果对应旧方案，请确认新方案并重新生成')
            plan = (task.get('analysis') or {}).get('plan') or {}
            capabilities = deepcopy(plan.get('requiredCapabilities', []))
            diagnosis = ((optimization.get('optimization') or {}).get('rounds') or [{}])[-1].get('diagnosis') if optimization else None
            hypothesis = diagnosis['hypothesis'] if diagnosis and diagnosis['status'] == 'PROPOSED' else {}
            for capability in value['requiredCapabilities'] + hypothesis.get('requiredCapabilities', []):
                existing = next((item for item in capabilities if item['id'] == capability['id']), None)
                if existing and fingerprint(existing) != fingerprint(capability):
                    raise MigrationControlError('补充能力合同与迁移方案冲突')
                if not existing:
                    capabilities.append(capability)
            frozen = await self.repository.read_snapshot(identifier, candidate['id'])
            settings = {key: item for key, item in value.items() if key not in ('baseCandidateId', 'runtimeType', 'requiredCapabilities', 'requiredFeatures', 'platform')}
            if settings.get('entryInstructionsFile') and settings['entryInstructionsFile'] not in frozen['files']:
                raise MigrationControlError('入口指令文件不存在', 400)
            size = stats(from_files(frozen))
            features = ['processEvidence', 'streaming'] + value['requiredFeatures'] + (['packagedMcp'] if candidate.get('services') else [])
            features.extend(item['feature'] for item in plan.get('runtimeFeatures', []) if item['required'])
            features.extend(hypothesis.get('requiredRuntimeFeatures', []))
            for case in (task.get('suite') or {}).get('cases', []):
                for check in (case.get('evaluationPlan') or {}).get('checks', []):
                    refs = check.get('evidenceRefs', []) + [(check.get('rule') or {}).get('reference', '')]
                    if any(ref.startswith('/telemetry') for ref in refs):
                        features.append('otlpEvidence')
                    if any(ref.startswith('/artifacts') for ref in refs):
                        features.append('artifactEvidence')
            if any(case.get('stateFixture') for case in (task.get('suite') or {}).get('cases', []) + (task.get('suite') or {}).get('holdoutCases', [])):
                features.append('caseStateLifecycle')
            requirements = {'schemaVersion': 'finance.runtime-build-requirements.v3', 'requestId': 'build-request-' + str(uuid4()),
                'target': {'runtimeType': value['runtimeType'], 'protocols': {'capabilities': 'finance.runtime-capabilities.v1',
                    'instance': 'finance.runtime-instance.v1', 'execution': 'finance.skill-eval.runtime-case.v1', 'observation': 'finance.runtime-observation.v1'}},
                'requiredCapabilities': capabilities, 'executionRequirements': {'platform': value['platform'], 'features': list(dict.fromkeys(features)),
                    'limits': {'maxSkills': len(candidate['members']), 'maxFiles': size['count'], 'maxArchiveBytes': size['bytes'], 'maxTimeoutMs': settings['timeoutMs']}}}
            baseline = task.get('runtimeDelivery', {}).get('launcher') if builder_status(task) == 'BOUND' else None
            if baseline and optimization and hypothesis:
                requirements['rebuild'] = {'baseline': {key: baseline[key] for key in ('deploymentId', 'artifactSha256', 'capabilitiesDigest')},
                    'hypothesis': {'id': optimization['id'], 'issue': hypothesis['issue'], 'expectedBehavior': hypothesis['expectedBehavior']},
                    'evidence': [{'evidenceRef': reference, 'summary': hypothesis['validation'][:1000]} for reference in hypothesis['evidenceCaseIds']]}
            requirements['requirementsDigest'] = fingerprint(requirements)
            requirements = parse('build_requirements', requirements)
            request = {'requirements': requirements, 'candidateId': candidate['id'], 'candidateDigest': candidate['digest'],
                **({'optimizationAttemptId': optimization['id']} if optimization else {}), 'settings': settings,
                'baseConfigurationDigest': fingerprint(task.get('configuration')), 'createdAt': now()}
            task.setdefault('runtimeBuildRequests', []).append(request)
            task.update(selectedRuntimeBuildRequestId=requirements['requestId'], runtimeSelectionRevision='selection-' + str(uuid4()))
            if waiting:
                waiting['requestId'] = requirements['requestId']
            if optimization and optimization.get('runtimeWait'):
                optimization['runtimeWait']['requestId'] = requirements['requestId']
        return await self.repository.update(identifier, update)

    async def requirements(self, identifier, request_id=None):
        task = await self.repository.get(identifier)
        request = next((item for item in task.get('runtimeBuildRequests', []) if item['requirements']['requestId'] == (request_id or task.get('selectedRuntimeBuildRequestId'))), None)
        if not request:
            raise MigrationControlError('请先生成 Builder 需求', 404)
        return request['requirements']

    async def use_existing(self, identifier):
        def update(task):
            idle(task)
            owner = owned_optimization(task)
            if owner and owner.get('optimization', {}).get('waiting', {}).get('kind') == 'BUILDER':
                raise MigrationControlError('本轮正在等待 Builder 改造，不能用原环境跳过；可以停止优化')
            if task.get('selectedRuntimeBuildRequestId'):
                task['runtimeSelectionRevision'] = 'selection-' + str(uuid4())
            task.pop('selectedRuntimeBuildRequestId', None)
        return await self.repository.update(identifier, update)

    async def accept(self, identifier, value, owner=None, *, automatic=False):
        if not isinstance(value, dict) or set(value) - {'result', 'trustReference', 'name'}:
            raise MigrationControlError('Builder 交付不符合当前标准协议', 400)
        result = parse('build_result', value['result'])
        assert_safe({'runtime-build-result.json': base64.b64encode(json.dumps(result).encode()).decode()})
        async def update(task):
            idle(task, owner, result['requestId'] if automatic else None)
            request = next((item for item in task.get('runtimeBuildRequests', []) if item['requirements']['requestId'] == result['requestId']), None)
            if not request or task.get('selectedRuntimeBuildRequestId') != result['requestId']:
                raise MigrationControlError('Builder 需求已被替换或不属于此任务')
            optimization = owned_optimization(task, owner or request.get('optimizationAttemptId')) if request.get('optimizationAttemptId') else None
            if request.get('optimizationAttemptId') and (not optimization or optimization['id'] != request['optimizationAttemptId'] or (
                    optimization.get('runtimeWait') or (optimization.get('optimization') or {}).get('waiting') or {}).get('requestId') != result['requestId']):
                raise MigrationControlError('该 Builder 需求对应的任务已结束或被替换')
            if optimization and optimization.get('optimization', {}).get('waiting'):
                self.service.control(task, optimization['id'], 'assert_optimization_inputs', {'facts': control_inputs(task)})
            candidate = next((item for item in task['candidates'] if item['id'] == request['candidateId']), None) if optimization else current_candidate(task)
            if not candidate:
                raise MigrationControlError('请先生成候选')
            replay = task.get('runtimeDelivery', {}).get('requestId') == result['requestId']
            if replay and (task['runtimeDelivery']['result']['resultDigest'] != result['resultDigest'] or builder_status(task) != 'BOUND'):
                raise MigrationControlError('该需求已绑定其他交付或配置已变化，请生成新需求')
            if self.service.configuration.get('managedWorkspace') and (candidate.get('services') or request['settings']['harnessTools']):
                raise MigrationControlError('托管工作区的自定义工具需要先由环境维护者接入', 403)
            accepted = await self.registry.accept_builder_delivery({'requirements': request['requirements'], **value, 'result': result})
            configuration = parse('task_configuration', {**request['settings'], **task.get('configuration', {}),
                'environmentId': accepted['environment']['environmentId'], 'modelId': request['settings'].get('modelId') or accepted['capabilities']['defaultModelId']})
            frozen = await self.repository.read_snapshot(identifier, candidate['id'])
            execution = await self.service.runtime(frozen, configuration, candidate.get('services', []))
            if fingerprint(execution['environmentSnapshot']['capabilities']) != result['launcher']['capabilitiesDigest']:
                raise MigrationControlError('Builder 环境能力在接收期间发生变化，请重新交付')
            binding = {'id': task['runtimeDelivery']['id'] if replay else 'binding-' + str(uuid4()), 'requestId': result['requestId'],
                'requirementsDigest': request['requirements']['requirementsDigest'], 'environmentSnapshot': execution['environmentSnapshot'],
                'launcher': {**accepted['environment']['delivery'], 'environmentId': accepted['environment']['environmentId']}, 'result': result}
            if replay and fingerprint(binding['environmentSnapshot']) != fingerprint(task['runtimeDelivery']['environmentSnapshot']):
                raise MigrationControlError('交付环境已变化，请生成新需求并重新接收')
            task.update(configuration=configuration, runtimeDelivery=binding)
            if not replay:
                task.setdefault('runtimeDeliveries', []).append(binding)
        return await self.repository.update(identifier, update)

    async def build(self, identifier, request_id, trust_reference, owner=None):
        task = await self.repository.get(identifier)
        request = next((item for item in task.get('runtimeBuildRequests', []) if item['requirements']['requestId'] == request_id), None)
        if not request or task.get('selectedRuntimeBuildRequestId') != request_id:
            raise MigrationControlError('Builder 需求已被替换或不属于此任务')
        if request.get('automatic', {}).get('status') == 'CANCELLED':
            raise MigrationControlError('该构建已取消，请重新生成 Builder 需求')
        if request['requirements'].get('rebuild'):
            raise MigrationControlError('当前 Builder 接口不支持 Runtime 重建；已保留诊断，需由外部完成重建')
        if fingerprint(task.get('configuration')) != request['baseConfigurationDigest']:
            raise MigrationControlError('运行配置已变化，请重新生成 Builder 需求')
        candidate = next((item for item in task['candidates'] if item['id'] == request['candidateId']), None)
        if not candidate or candidate['digest'] != request['candidateDigest'] or not owner and task['currentCandidateId'] != candidate['id']:
            raise MigrationControlError('Builder 对应的候选已变化或过期')
        frozen = await self.repository.read_snapshot(identifier, candidate['id'])
        if frozen['digest'] != request['candidateDigest']:
            raise MigrationControlError('Builder 候选快照摘要不一致')
        model_id = request['settings'].get('modelId') or task.get('configuration', {}).get('modelId')
        if not model_id:
            raise MigrationControlError('请先配置 Builder 使用的模型')
        public, secrets = runtime_inputs(request['settings'])
        instance = {'schemaVersion': 'finance.runtime-instance.v1', 'runId': request_id, 'side': 'right', 'modelId': model_id,
            **from_files({**frozen, **({'entryInstructionsFile': request['settings']['entryInstructionsFile']} if request['settings'].get('entryInstructionsFile') else {})}),
            'environment': {'environmentId': 'builder-' + request_id, 'requiredToolNames': [item['name'] for item in request['requirements']['requiredCapabilities'] if item['required']],
                'harnessToolNames': request['settings']['harnessTools'], 'availableToolNames': list(dict.fromkeys(name for service in candidate.get('services', []) for name in service['toolNames'])),
                'candidateMcpServices': [{**service, 'assetDigest': frozen['digest']} for service in candidate.get('services', [])]},
            'configuration': public, 'secrets': {'mode': 'inline', 'values': secrets}, 'limits': {'timeoutMs': request['settings']['timeoutMs']}}
        client = BuilderClient(os.getenv('FINANCE_EVAL_BUILDER_BASE_URL', ''), os.getenv('FINANCE_EVAL_BUILDER_TOKEN', ''))
        build_id = request.get('automatic', {}).get('buildId')
        def running(task):
            idle(task, owner, request_id)
            item = next(item for item in task['runtimeBuildRequests'] if item['requirements']['requestId'] == request_id)
            if task.get('selectedRuntimeBuildRequestId') != request_id or not owner and task['currentCandidateId'] != item['candidateId']:
                raise MigrationControlError('Builder 需求已变化或对应候选已过期')
            if item.get('automatic', {}).get('status') == 'RUNNING':
                raise MigrationControlError('该 Builder 构建正在执行')
            item['automatic'] = {**item.get('automatic', {}), 'status': 'RUNNING', 'trustReference': trust_reference,
                'startedAt': item.get('automatic', {}).get('startedAt') or now()}
            item['automatic'].pop('error', None)
            item['automatic'].pop('finishedAt', None)
        await self.repository.update(identifier, running)
        try:
            state = await client.invoke('get', build_id=build_id) if build_id else await client.invoke('submit',
                requirements=request['requirements'], instance_request=instance, idempotency_key=request_id)
            build_id = state.get('buildId')
            if not isinstance(build_id, str) or not build_id:
                raise MigrationControlError('Builder 未返回构建标识')
            def identified(task):
                next(item for item in task['runtimeBuildRequests'] if item['requirements']['requestId'] == request_id)['automatic']['buildId'] = build_id
            await self.repository.update(identifier, identified)
            while not state.get('result'):
                if state.get('status') not in ('starting', 'ready', 'RUNNING', 'PENDING'):
                    raise MigrationControlError('Builder 构建未完成：' + str(state.get('status')))
                await asyncio.sleep(1)
                state = await client.invoke('get', build_id=build_id)
            result = parse('build_result', state['result'])
            if result['buildId'] != build_id or result['requestId'] != request_id or result['status'] != 'SUCCEEDED':
                raise MigrationControlError('Builder 未交付匹配的有效 Runtime')
            current = await self.repository.get(identifier)
            if current.get('selectedRuntimeBuildRequestId') != request_id or fingerprint(current.get('configuration')) != request['baseConfigurationDigest'] or not owner and current['currentCandidateId'] != request['candidateId']:
                raise MigrationControlError('构建期间任务已变化，交付未绑定')
            return await self.accept(identifier, {'result': result, 'trustReference': trust_reference}, owner, automatic=True)
        except BaseException as error:
            cancelled = isinstance(error, asyncio.CancelledError)
            if cancelled and build_id and not self.service.closing:
                try:
                    async with asyncio.timeout(5):
                        await client.invoke('cancel', build_id=build_id)
                except Exception:
                    pass
            def failed(task):
                item = next((item for item in task.get('runtimeBuildRequests', []) if item['requirements']['requestId'] == request_id), None)
                if item and item.get('automatic'):
                    item['automatic'].update(status=('INTERRUPTED' if self.service.closing else 'CANCELLED') if cancelled else 'FAILED',
                        finishedAt=now(), error='服务关闭，构建待恢复' if cancelled and self.service.closing else '构建已取消' if cancelled else str(error))
            await self.repository.update(identifier, failed)
            raise

    async def check_candidate(self, identifier, request_id, owner=None):
        task = await self.repository.get(identifier)
        request = next(item for item in task['runtimeBuildRequests'] if item['requirements']['requestId'] == request_id)
        delivery = task.get('runtimeDelivery')
        candidate = next((item for item in task['candidates'] if item['id'] == request['candidateId']), None)
        if not delivery or delivery['requestId'] != request_id or not candidate or task['currentCandidateId'] != candidate['id'] or candidate['digest'] != request['candidateDigest']:
            raise MigrationControlError('缺少与待验证候选匹配的 Runtime 交付')
        def state(task, status):
            item = next(item for item in task['runtimeBuildRequests'] if item['requirements']['requestId'] == request_id)
            if task.get('runtimeDelivery', {}).get('id') != delivery['id'] or task.get('selectedRuntimeBuildRequestId') != request_id:
                raise MigrationControlError('Runtime 交付已变化')
            item.setdefault('automatic', {})['startupCheck'] = {'candidateId': candidate['id'], 'candidateDigest': candidate['digest'],
                'deliveryId': delivery['id'], 'status': status, 'startedAt': now(), **({'finishedAt': now()} if status != 'RUNNING' else {})}
        await self.repository.update(identifier, lambda task: state(task, 'RUNNING'))
        try:
            await self.service.check_runtime(identifier, request_id, owner)
            await self.repository.update(identifier, lambda task: state(task, 'PASSED'))
        except BaseException:
            await self.repository.update(identifier, lambda task: state(task, 'INTERRUPTED' if self.service.closing else 'FAILED'))
            raise

    async def continue_runtime(self, identifier, request_id):
        result = None
        def update(task):
            nonlocal result
            owner = next((item for item in task['attempts'] if item['kind'] == 'CHAT' and item.get('runtimeWait', {}).get('requestId') == request_id), None)
            baseline = (owner.get('optimizationBaselineRunId') or (owner.get('optimization') or {}).get('workingEvaluationId') or owner.get('runId')) if owner else None
            result = self.service.control(task, '', 'runtime_ready', {'requestId': request_id, 'builderStatus': builder_status(task), 'persisted': True,
                'configurationDigest': fingerprint(task.get('configuration')), 'inputDigest': session_input_digest(task, baseline),
                'requestDigest': fingerprint({'requestId': request_id, 'deliveryId': task.get('runtimeDelivery', {}).get('id')})})
        await self.repository.update(identifier, update)
        return result.get('attemptId') if result['next'] == 'agent' else None

    async def prepare_for_agent(self, identifier, attempt_id, value):
        request_id = value['requestId']
        instruction = None
        def requested(task):
            nonlocal instruction
            instruction = self.service.control(task, attempt_id, 'runtime_requested', {'requestId': request_id, 'reason': value['reason'],
                'builderAvailable': True, 'requiredFeatures': value.get('requiredFeatures', [])})
        task = await self.repository.update(identifier, requested)
        if instruction['next'] == 'refresh':
            task = await self.request(identifier, instruction['settings'], attempt_id)
            request_id = task['selectedRuntimeBuildRequestId']
        def waiting(task):
            next(item for item in task['attempts'] if item['id'] == attempt_id)['runtimeWait'] = {'requestId': request_id, 'reason': value['reason']}
            next(item for item in task['runtimeBuildRequests'] if item['requirements']['requestId'] == request_id)['optimizationAttemptId'] = attempt_id
        await self.repository.update(identifier, waiting)
        trust = os.getenv('FINANCE_EVAL_BUILDER_TRUST_REFERENCE')
        if not trust or not os.getenv('FINANCE_EVAL_BUILDER_BASE_URL') or not os.getenv('FINANCE_EVAL_BUILDER_TOKEN'):
            await self.repository.update(identifier, lambda task: self.service.control(task, attempt_id, 'runtime_wait'))
            return None
        try:
            await self.build(identifier, request_id, trust, attempt_id)
            await self.check_candidate(identifier, request_id, attempt_id)
            def succeeded(task):
                request = next(item for item in task['runtimeBuildRequests'] if item['requirements']['requestId'] == request_id)
                request['automatic'].update(status='SUCCEEDED', finishedAt=now())
                next(item for item in task['attempts'] if item['id'] == attempt_id)['status'] = 'WAITING'
            await self.repository.update(identifier, succeeded)
        except Exception as error:
            await self.repository.update(identifier, lambda task: self.service.control(task, attempt_id, 'runtime_wait', {'error': str(error)}))
            return None
        return await self.continue_runtime(identifier, request_id)

    async def start(self, identifier, value):
        from storage.repository import execution_owner
        from storage.coordination import CoordinationConflict
        if not isinstance(value, dict) or set(value) != {'requestId', 'trustReference'}:
            raise MigrationControlError('Invalid Builder start request', 400)
        request_id, trust = value['requestId'], value['trustReference']
        if not isinstance(trust, str) or not __import__('re').fullmatch('[a-z0-9-]+', trust):
            raise MigrationControlError('Invalid Builder trust reference', 400)
        task = await self.repository.get(identifier)
        self.service.idle(task)
        request = next((item for item in task.get('runtimeBuildRequests', []) if item['requirements']['requestId'] == request_id), None)
        if not request or task.get('selectedRuntimeBuildRequestId') != request_id:
            raise MigrationControlError('Builder 需求已变化')
        owner = request.get('optimizationAttemptId')
        if owner and not owned_optimization(task, owner):
            raise MigrationControlError('构建不再属于等待中的任务')
        if request['requirements'].get('rebuild'):
            raise MigrationControlError('当前 Builder 接口不支持 Runtime 重建；请保留诊断并等待外部交付')
        if request.get('automatic', {}).get('status') == 'CANCELLED' and task.get('runtimeDelivery', {}).get('requestId') != request_id:
            raise MigrationControlError('该构建已取消，请重新生成 Builder 需求')
        key = 'task-execution:' + identifier
        token = await self.repository.acquire(key)
        if not token:
            raise CoordinationConflict('该任务正在由其他请求处理')
        scope = execution_owner.set({'root': self.repository.root, 'id': identifier, 'token': token})
        handed_off = False
        try:
            def queued(task):
                idle(task)
                item = next(item for item in task['runtimeBuildRequests'] if item['requirements']['requestId'] == request_id)
                if task.get('selectedRuntimeBuildRequestId') != request_id or item.get('automatic', {}).get('status') in ('QUEUED', 'RUNNING'):
                    raise MigrationControlError('Builder 需求已变化或正在执行')
                item['automatic'] = {**item.get('automatic', {}), 'status': 'QUEUED', 'trustReference': trust,
                    'startedAt': item.get('automatic', {}).get('startedAt') or now()}
                item['automatic'].pop('error', None)
                item['automatic'].pop('finishedAt', None)
            reserved = await self.repository.update(identifier, queued)
            async def execute():
                try:
                    current = await self.repository.get(identifier)
                    binding = current.get('runtimeDelivery')
                    if not binding or binding['requestId'] != request_id or builder_status(current) != 'BOUND':
                        await self.build(identifier, request_id, trust, owner)
                    await self.check_candidate(identifier, request_id, owner)
                    def succeeded(task):
                        item = next(item for item in task['runtimeBuildRequests'] if item['requirements']['requestId'] == request_id)
                        item['automatic'].update(status='SUCCEEDED', finishedAt=now())
                        if not owner:
                            item['automatic']['basicValidation'] = {'status': 'PENDING', 'key': 'builder-basic-' + str(uuid4()),
                                'candidateId': task['currentCandidateId'], 'configurationDigest': fingerprint(task.get('configuration')), 'suiteDigest': suite_digest(task.get('suite'))}
                    await self.repository.update(identifier, succeeded)
                    if owner:
                        attempt_id = await self.continue_runtime(identifier, request_id)
                        if attempt_id:
                            await self.service.ports.run(identifier, attempt_id)
                except BaseException as error:
                    def failed(task):
                        item = next((item for item in task.get('runtimeBuildRequests', []) if item['requirements']['requestId'] == request_id), None)
                        if item and item.get('automatic'):
                            if item['automatic']['status'] == 'SUCCEEDED':
                                item['automatic']['error'] = '已交付，后续基础验证待继续：' + str(error)
                            else:
                                item['automatic'].update(status=('INTERRUPTED' if self.service.closing else 'CANCELLED') if isinstance(error, asyncio.CancelledError) else 'FAILED',
                                    finishedAt=now(), error=str(error) or ('服务关闭，构建或启动检查待恢复' if self.service.closing else '构建或启动检查已取消'))
                    await self.repository.update(identifier, failed)
                    if isinstance(error, asyncio.CancelledError):
                        raise
                finally:
                    self.service.operations.pop(identifier, None)
                    await self.repository.release(key, token)
            pending = asyncio.create_task(execute(), name='runtime-build:' + identifier)
            self.service.operations[identifier] = {'task': pending, 'builder': request_id}
            pending.add_done_callback(self.service.operation_done)
            handed_off = True
            return await self.service.view(reserved)
        finally:
            execution_owner.reset(scope)
            if not handed_off:
                await self.repository.release(key, token)

    async def resume_basic(self, identifier, request_id):
        task = await self.repository.get(identifier)
        request = next((item for item in task.get('runtimeBuildRequests', []) if item['requirements']['requestId'] == request_id), {})
        basic = request.get('automatic', {}).get('basicValidation')
        if not basic or basic['status'] == 'WAITING' or request.get('optimizationAttemptId'):
            return
        reason = None
        if (task.get('selectedRuntimeBuildRequestId') != request_id or task.get('runtimeDelivery', {}).get('requestId') != request_id or builder_status(task) != 'BOUND'
                or task['currentCandidateId'] != basic['candidateId'] or suite_digest(task.get('suite')) != basic['suiteDigest'] or fingerprint(task.get('configuration')) != basic['configurationDigest']):
            reason = '候选、测试集或运行环境已变化，请重新选择基础验证'
        elif not task.get('suite') or any(case.get('repeatSafety') != 'read_only' and not case.get('stateFixture') for case in task['suite']['cases']):
            reason = '案例未声明只读或可恢复状态，请手动选择基础验证'
        prior = next((item for item in task['attempts'] if item['key'] == basic['key']), None)
        if prior and prior['status'] == 'INTERRUPTED':
            if any(case.get('repeatSafety') != 'read_only' for case in task['suite']['cases']):
                reason = '上次运行中断，状态恢复尚未确认，请先检查后手动复测'
            else:
                basic = {**basic, 'key': 'builder-basic-' + str(uuid4()), 'status': 'PENDING'}
        if reason:
            def waiting(task):
                next(item for item in task['runtimeBuildRequests'] if item['requirements']['requestId'] == request_id)['automatic']['basicValidation'].update(status='WAITING', reason=reason)
            await self.repository.update(identifier, waiting)
            return
        if basic['status'] != 'PENDING':
            return
        result = await self.service.start(identifier, 'CHAT', {'key': basic['key'], 'baseCandidateId': basic['candidateId'],
            'clarification': '所选 Runtime 已完成交付与启动核验。请继续当前迁移任务，根据用户目标检查工程和实际工具入口，必要时运行现有开发集，发现问题诊断并修复后复测，再请求独立审查；不要把启动成功当作业务验证通过。'})
        def started(task):
            next(item for item in task['runtimeBuildRequests'] if item['requirements']['requestId'] == request_id)['automatic']['basicValidation'] = {
                **basic, 'status': 'STARTED', 'attemptId': next(item for item in result['attempts'] if item['key'] == basic['key'])['id']}
        await self.repository.update(identifier, started)
