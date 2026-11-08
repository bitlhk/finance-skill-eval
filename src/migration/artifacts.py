"""Publication rules for migration workspaces, preparation and review records."""
from copy import deepcopy
from uuid import uuid4
from .state import MigrationControlError, now, finish


def candidate(task, current, result, revision, executions, diff):
    previous = next((item for item in task['candidates'] if item['id'] == task.get('currentCandidateId')), {})
    delivery = result.get('deliveryTools')
    files = revision['files']
    services = delivery.get('services', []) if delivery else [item for item in previous.get('services', []) if all(path in files for path in item['filePaths'])]
    names = [name for service in services for name in service['toolNames']]
    tools = delivery.get('tools') if delivery else ([item for item in previous['tools'] if all(path in files for path in item['files'])
            and (item['form'] != 'MCP' or item['entrypoint'] in names)] if 'tools' in previous else None)
    for service in services:
        for path in service['filePaths']:
            if path not in files:
                raise MigrationControlError('服务交付文件缺失：' + path)
    if len(set(names)) != len(names):
        raise MigrationControlError('共享服务工具名称冲突')
    for tool in tools or []:
        if any(path not in files for path in tool['files']):
            raise MigrationControlError('工具交付文件缺失：' + tool['toolId'])
        if tool['form'] == 'MCP' and tool['entrypoint'] not in names:
            raise MigrationControlError('MCP 工具没有对应服务：' + tool['toolId'])
    value = {'id': 'candidate-' + str(uuid4()), 'parentId': current.get('baseCandidateId'), 'createdAt': now(),
             'digest': revision['digest'], 'members': revision['members'], 'summary': result['message'][:20000],
             'draft': True, 'services': services, 'executions': executions, 'diff': diff, 'checks': []}
    if task.get('planRevisionId') is not None:
        value['planRevisionId'] = task['planRevisionId']
    if tools is not None:
        value['tools'] = tools
    return value


def _prepared(task, current, inputs):
    preparation = inputs['preparation']
    if not any(item['id'] == preparation['id'] for item in task.get('preparations', [])):
        task.setdefault('preparations', []).append(deepcopy(preparation))
    finish(current, '工程准备副本和说明已保存，请核对缺口并实际运行基线')
    current['executions'] = preparation['executions']
    for key in ('analysis', 'planRevisionId', 'planApproved'):
        task.pop(key, None)


def _published(task, current, inputs):
    value = inputs['candidate']
    if task.get('currentCandidateId') != inputs.get('expectedCandidateId'):
        raise MigrationControlError('工作版本已变化，不能发布过期执行的结果')
    if not any(item['id'] == value['id'] for item in task['candidates']):
        task['candidates'].append(deepcopy(value))
    task['currentCandidateId'] = value['id']
    current.update(resultCandidateId=value['id'], executions=value['executions'])


def _executions(task, current, inputs):
    current['executions'] = deepcopy(inputs['executions'])


def _delivery_reviews(task, current, inputs):
    value = next((item for item in task['candidates'] if item['id'] == task.get('currentCandidateId')), None)
    if not value or value['digest'] != inputs['digest']:
        return
    fields = ('decision', 'summary', 'issues', 'citations', 'basicReview')
    for review in inputs['reviews']:
        duplicate = any(item['attemptId'] == current['id'] and item['workspaceDigest'] == review['workspaceDigest']
                        and all(item.get(key) == review.get(key) for key in fields) for item in task.get('deliveryReviews', []))
        if not duplicate:
            task.setdefault('deliveryReviews', []).append({'id': 'delivery-review-' + str(uuid4()), 'attemptId': current['id'],
                'scopeDigest': inputs['scopeDigest'], 'candidateId': value['id'], 'createdAt': now(), **deepcopy(review)})


def _budget_requested(task, current, inputs):
    request = inputs['request']
    if not request.get('additionalRounds') and not request.get('additionalSeconds'):
        raise MigrationControlError('请明确需要增加的轮次或时间')
    finish(current, '正在核对并继续原优化')
    current['budgetContinuation'] = {**deepcopy(request), 'status': 'PENDING'}
