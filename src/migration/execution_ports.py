"""Direct Python I/O for the existing migration application program."""
import asyncio
from copy import deepcopy
import json
from uuid import uuid4

from agents.migration import run_migration
from agents.model_roles import execute_role
from agents.criterion import QuietOutput
from api.contracts import parse
from assets.snapshot import execute as snapshot
from improvement.basic_review import execute as validate_basic
from improvement.policy import review_input
from improvement.review_diff import execute as review_diff
from tasks.application_host import run_program
from tasks.values import fingerprint
from .acceptance_service import evaluate_task
from .evaluation_view import optimization_evaluation, diagnosis_input
from .facts import current_candidate, control_inputs, session_input_digest, builder_status, input_issues, development_current, completed_repetitions, scope_digest, suite_digest
from .integrity import valid_delivery_review, execution_receipts
from .state import MigrationControlError
from . import execution


class ExecutionPorts:
    def __init__(self, service):
        self.service = service
        self.repository = service.repository

    async def handle(self, capability, inputs):
        service, repository = self.service, self.repository
        identifier, attempt_id = inputs['taskId'], inputs.get('attemptId')
        if capability == 'load':
            return await service.synchronize_goal(identifier)
        if capability == 'transition':
            result = None
            async def transition(task):
                nonlocal result
                facts = control_inputs(task, service.judge_identity(), session_input_digest(task))
                details = {'persisted': True, 'inputDigest': session_input_digest(task, inputs.get('inputs', {}).get('inputRunId')),
                    'facts': facts, 'configurationDigest': facts['configurationDigest'], 'bindingError': facts['bindingError'],
                    'runtimeInputIssues': facts['runtimeInputIssues'], 'optimizationInputs': {'suiteDigest': suite_digest(task.get('suite')),
                        'planDigest': facts['planDigest'], 'judgeDigest': service.judge_identity()}, **inputs.get('inputs', {})}
                result = service.control(task, attempt_id, inputs['action'], details)
            task = await repository.update(identifier, transition)
            return {'task': task, 'value': result}
        if capability == 'inspect':
            task = await repository.get(identifier)
            attempt = next(item for item in task['attempts'] if item['id'] == attempt_id)
            return service.control(task, attempt_id, inputs['action'], {'inputDigest': session_input_digest(task, attempt.get('runId'))})
        if capability == 'execution_observation':
            status = await service.agent_runtime.execution_status(identifier, inputs['executionId'])
            return {'status': status, 'paused': None if status['available'] else await repository.conversation(identifier, 'pausedRound', attemptId=attempt_id),
                'round': None if status['available'] else await repository.conversation(identifier, 'recoveryRound', attemptId=attempt_id)}
        if capability == 'continue_execution':
            task = inputs['task']
            return await self.run(task['id'], attempt_id, reattach=inputs.get('reattach', False))
        if capability == 'progress':
            return await service.progress(identifier, attempt_id, inputs['message'])
        if capability == 'observe':
            task, attempt = inputs['task'], inputs['attempt']
            source, base = await asyncio.gather(repository.read_snapshot(identifier), repository.read_snapshot(identifier,
                attempt.get('baseCandidateId') or (task.get('preparations') or [{}])[-1].get('id')))
            discussions = []
            for run_id in inputs['runIds']:
                run = next((item for item in task['runs'] if item['id'] == run_id), None)
                if not run or run['phase'] != 'development':
                    raise MigrationControlError('仅开发集证据可提供给迁移 Agent')
                try:
                    evaluated = await repository.read_snapshot(identifier, run['candidateId'])
                    diagnosed = diagnosis_input(task, run, evaluated)
                    discussions.append({'runId': run_id, 'phase': 'development', 'candidateId': run['candidateId'], 'candidateDigest': run['candidateDigest'],
                        'matchesCurrentWorkspace': run['candidateDigest'] == base['digest'], 'matchesCurrentConfiguration': development_current(task, run, service.judge_identity()),
                        'status': run['status'], 'effectStatus': run.get('effectStatus', run['status']),
                        **{key: diagnosed[key] for key in ('cases', 'evaluationEvidence', 'runtimeRequirements')},
                        'reviews': [review for review in task.get('effectReviews', []) if review['candidateRunId'] == run_id]})
                except (ValueError, OSError):
                    discussions.append({'runId': run_id, 'phase': 'development', 'candidateId': run['candidateId'], 'candidateDigest': run['candidateDigest'],
                        'status': 'UNAVAILABLE', 'reason': '关联的评测材料暂时无法核对，请勿据此判断。'})
            feedback = {'developmentEvaluations': discussions, 'developmentExecutions': execution_receipts(task)[-100:]}
            candidate = current_candidate(task) or {}
            if 'tools' in candidate or candidate.get('services'):
                feedback['deliveryTools'] = {'services': candidate.get('services', []), 'tools': candidate.get('tools', [])}
            if candidate.get('conformance'):
                feedback['standardizationReview'] = {'candidateId': task['currentCandidateId'], 'candidateDigest': base['digest'], 'review': candidate['conformance']}
            issues = ['请先配置 Runtime 和开发测试集'] if not task.get('configuration') or not task.get('suite') else input_issues(task, task['configuration'], True)
            if task.get('configuration') and task.get('suite') and builder_status(task) in ('PENDING', 'STALE'):
                issues.append('所选 Runtime 交付尚未就绪')
            request = next((item for item in task.get('runtimeBuildRequests', []) if item['requirements']['requestId'] == task.get('selectedRuntimeBuildRequestId')), None)
            from runtime.models import configured_model_role
            return {'source': source, 'base': base, 'feedback': feedback, 'evaluationIssues': issues,
                'reviewAvailable': configured_model_role('JUDGE')['configured'], 'facts': control_inputs(task, service.judge_identity()),
                'checkpointRoot': repository.root, **({'runtimePreparation': {'requestId': request['requirements']['requestId'],
                    'rebuild': bool(request['requirements'].get('rebuild')), 'status': builder_status(task),
                    'allowedFeatures': service.runtime_features}} if request and builder_status(task) in ('PENDING', 'STALE') else {})}
        if capability == 'agent':
            task = await repository.get(identifier)
            attempt = next(item for item in task['attempts'] if item['id'] == attempt_id)
            async def composition(receipt):
                def update(task):
                    entry = next(item for item in task['attempts'] if item['id'] == attempt_id)
                    entry['agentCompositions'] = [item for item in entry.get('agentCompositions', []) if item['role'] != receipt['role']] + [receipt]
                await repository.update(identifier, update)
            return await service.agent(inputs['input'], {'taskId': identifier, 'attemptId': attempt_id,
                'requestId': attempt.get('requestId'), 'agentRunId': attempt['agentRunId']}, runtime=service.agent_runtime,
                on_activity=lambda event: service.activity(identifier, attempt_id, event), on_composition=composition)
        if capability == 'freeze':
            task, base, result = inputs['task'], inputs['base'], inputs['result']
            attempt = next(item for item in task['attempts'] if item['id'] == attempt_id)
            project = task.get('inputKind') == 'agent_project' and (
                attempt.get('prepareProject') or task.get('configuration', {}).get('executionMode') == 'agent_project')
            values = {'action': 'snapshot', 'files': result['files'], 'version': 'source' if project else 'r' + str(len(task['candidates']) + 1)}
            if project:
                values['project'] = True
            elif base['members']:
                values['previous'] = base
            return {'revision': await asyncio.to_thread(snapshot, values), 'executions': [parse('project_execution', value) for value in result.get('executions', [])]}
        if capability == 'diff':
            return await asyncio.to_thread(snapshot, {'action': 'diff', 'before': inputs['before'], 'after': inputs['after']})
        if capability == 'save_snapshot':
            return await repository.save_snapshot(identifier, inputs['id'], inputs['revision'], inputs['parent'])
        if capability == 'evaluation_view':
            run = next((item for item in inputs['task']['runs'] if item['id'] == inputs.get('runId')), None)
            return optimization_evaluation(inputs['task'], run) if run and run['phase'] == 'development' else None
        if capability == 'validate_delivery_reviews':
            revision, result, observed = inputs['revision'], inputs['result'], inputs['observed']
            reviews = []
            for item in result.get('deliveryReviews', []):
                review = valid_delivery_review(item, revision['files'], revision['digest'])
                if review and review.get('basicReview'):
                    valid = validate_basic({'review': review['basicReview'], 'digest': revision['digest'],
                        'checks': observed['feedback']['developmentExecutions'] + inputs['executions'], 'runs': observed['feedback']['developmentEvaluations']})
                    if not valid.get('valid'):
                        review = None
                reviews.append(review or {'workspaceDigest': revision['digest'], 'decision': 'INCONCLUSIVE',
                    'summary': '本次独立审查的结果或证据未能验证，请重新审查。', 'issues': [], 'citations': []})
            return {'reviews': reviews, 'scopeDigest': scope_digest(await repository.get(identifier))}
        if capability == 'runtime_preparation':
            return await service.prepare_runtime(identifier, attempt_id, inputs['request'])
        if capability == 'budget_continuation':
            return await service.dispatch_budget(identifier, attempt_id)
        if capability == 'evaluate':
            return await evaluate_task(service, inputs['task'], inputs['attempt'], inputs['phase'], inputs['purpose'])
        if capability == 'evaluation_result':
            task = await repository.get(identifier)
            attempt = next(item for item in task['attempts'] if item['id'] == attempt_id)
            run = next((item for item in task['runs'] if item['id'] == attempt.get('runId')), None)
            before = next((item for item in task['runs'] if item['id'] == inputs.get('previousRunId')), None)
            return {'task': task, 'run': run, 'after': optimization_evaluation(task, run) if run else None,
                'before': optimization_evaluation(task, before) if before else None, 'repetitionsComplete': bool(completed_repetitions(task, run, 'effect')) if run else False,
                'facts': control_inputs(task, service.judge_identity())}
        if capability == 'review':
            task, instruction = inputs['task'], inputs['instruction']
            before, after, incumbent = (next((item for item in task['runs'] if item['id'] == instruction.get(key)), None) for key in ('baselineRunId', 'candidateRunId', 'incumbentRunId'))
            before_files, after_files = await asyncio.gather(repository.read_snapshot(identifier, before['candidateId'] if before else None), repository.read_snapshot(identifier, after['candidateId']))
            diff = snapshot({'action': 'diff', 'before': before_files['files'], 'after': after_files['files']})
            changes = review_diff({'changes': [{'path': item['path'], 'reason': item['kind'], 'before': before_files['files'].get(item['path'], ''), 'after': after_files['files'].get(item['path'], '')} for item in diff]})
            baseline, evaluated, prior = (optimization_evaluation(task, run) if run else None for run in (before, after, incumbent))
            loop = instruction.get('activeOptimization')
            context = {'incumbent': prior, 'protectedCaseIds': loop['goal'].get('protectedCaseIds', []), 'targetPassRate': loop['goal'].get('targetPassRate'),
                'remainingRounds': instruction['remainingRounds'], 'contextChanges': loop.get('contextChanges', [])} if loop else {}
            material = review_input(loop['goal']['goal'] if loop else task['goal'], baseline, evaluated, changes, context)
            review = await service.reviewer(material, identifier, attempt_id)
            return {'baseline': baseline, 'evaluated': evaluated, 'incumbent': prior, 'review': review, 'evidence': material['evidence'], 'scopeDigest': scope_digest(task)}
        if capability == 'failure_facts':
            task = await repository.get(identifier)
            attempt = next((item for item in task['attempts'] if item['id'] == attempt_id), {})
            conversation = await repository.conversation(identifier, after=0, limit=1) if attempt.get('sessionAnswer') else {}
            return {'retryInteraction': any(item['interactionId'] == attempt['sessionAnswer']['interactionId'] and item['status'] in ('pending', 'answered') for item in conversation.get('interactions', []))}
        if capability == 'log_finished':
            return None
        raise ValueError('Unknown migration capability: ' + capability)

    async def run(self, identifier, attempt_id, phase='development', *, reattach=False, recover=False):
        request = {'taskId': identifier, 'attemptId': attempt_id, 'phase': phase, 'reattach': reattach}
        program = execution.recover(request) if recover else execution.run(request)
        names = ('load', 'transition', 'inspect', 'execution_observation', 'continue_execution', 'progress', 'observe', 'agent', 'freeze', 'diff', 'save_snapshot',
            'evaluation_view', 'validate_delivery_reviews', 'runtime_preparation', 'budget_continuation', 'evaluate', 'evaluation_result', 'review', 'failure_facts', 'log_finished')
        return await run_program(program, {name: (lambda inputs, name=name: self.handle(name, inputs)) for name in names},
                                 cancellation_context=lambda: {'closing': self.service.closing})
