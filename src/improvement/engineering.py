"""Use the existing main engineering Agent and Git workspace for asset edits."""
from copy import deepcopy
from uuid import uuid4
from agents.migration import run_migration
from assets.snapshot import make_snapshot
from assets.export import assert_safe
from improvement.source import source_evidence
from storage.repository import TaskRepository


async def adjust(root, session_id, source, current, goal, evaluations, *, diagnosis=None,
                 constraints=None, continuation=None, agent=run_migration, on_composition=None, delivery_tools=None):
    omitted = source_evidence(current)['omitted']
    sensitive = {item['path'] for item in omitted + source_evidence(source)['omitted'] if item['reason'] == 'sensitive'}
    binary = {item['path'] for item in omitted if item['reason'] == 'binary'}
    original = make_snapshot({name: value for name, value in source.items() if name not in sensitive}, 'source', project=True)
    base = make_snapshot({name: value for name, value in current.items() if name not in sensitive}, 'current', project=True)
    await TaskRepository(root).save_snapshot(session_id, 'source', original)
    attempt_id = (continuation or {}).get('attemptId') or 'attempt-' + str(uuid4())
    task_session = {'executionId': (continuation or {}).get('executionId') or str(uuid4())}
    if continuation:
        task_session.update(answer=continuation['answer'])
        if continuation.get('reattach'):
            task_session['reattach'] = True
    evidence = [dict(value, candidateDigest=base['digest']) for value in evaluations]
    result = await agent({'mode': 'CHAT', 'source': original, 'base': base, 'goal': goal,
        'target': '保留 Skill 和工具的业务语义并改进用户指定的效果',
        'clarification': '这是外层优化编排委派的单次文件调整。根据任务目标、开发集证据和诊断自主调整 Skill、脚本或随包交付的工具。保留身份和业务约束；外部工具不能直接修改时说明原因。完成调整及必要的局部检查后直接返回；正式业务复测和独立 Review 由外层编排负责，本轮不再委派交付审查、不重复执行完整迁移流程。',
        'agentFollowup': True, 'reviewAvailable': False,
        'evaluationAvailability': {'ready': False, 'reason': '本轮调整结束后平台执行复测'},
        'feedback': {'diagnosis': diagnosis, 'developmentEvaluations': evidence,
            'assetOmissions': omitted, 'constraints': constraints,
            **({'deliveryTools': delivery_tools} if delivery_tools is not None else {})},
        'checkpointRoot': str(root), 'taskSession': task_session},
        {'taskId': session_id, 'attemptId': attempt_id, 'agentRunId': 'agent-' + str(uuid4())}, on_composition=on_composition)
    if result['status'] == 'WAITING':
        interactions = result.get('interactions', [])
        if not any(isinstance(item, dict) and (item.get('id') or item.get('interaction_id')) for item in interactions):
            raise ValueError('Agent 等待用户回答，但没有有效的问题标识')
        return {'status': 'WAITING', 'attemptId': attempt_id, 'interactions': interactions}
    if result['status'] == 'ABSTAINED':
        return result
    if not result.get('message') or not isinstance(result.get('files'), dict):
        raise ValueError('Agent 未返回调整说明或工作文件')
    if any(result.get(name) for name in ('evaluationRequested', 'optimizationRequest', 'reviewRequested', 'budgetRequest')):
        raise ValueError('调整完成后由当前优化任务执行评测和审查')
    # Incidental read-only observations are not effect approval and must not
    # invalidate otherwise valid edits. The outer loop still owns its Review.
    files = deepcopy(result['files'])
    for name in sensitive:
        if name in files:
            raise ValueError('工作区不能修改未提供的敏感文件')
        if name in current:
            files[name] = current[name]
    if any(files.get(name) != current[name] for name in binary):
        raise ValueError('工作区不能修改未作为文本提供的文件')
    changed = {name: value for name, value in files.items() if current.get(name) != value}
    if changed:
        assert_safe(changed)
    make_snapshot(files, 'candidate', project=True)
    return {'status': 'PRODUCED', 'files': files, 'summary': result['message'],
        'changed': list(changed) + list(set(current) - set(files)),
        **({'deliveryTools': deepcopy(result['deliveryTools'])} if result.get('deliveryTools') is not None else {})}
