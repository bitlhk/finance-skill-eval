"""Deliver the frozen project plus independently verified evidence and manifests."""
import base64
import json

from assets.export import bundle_zip, assert_safe
from tasks.values import fingerprint
from .facts import current_candidate, input_issues, require_binding, builder_status, scope_digest
from .integrity import verify_delivery, basic_report, effect_report, basic_current
from .plan_review import review_environment
from .state import MigrationControlError


async def export_task(service, identifier, verified=False, basic_scoped=False):
    task = await service.synchronize_goal(identifier)
    candidate = current_candidate(task)
    if not candidate:
        raise MigrationControlError('尚未生成候选')
    if basic_scoped and verified:
        raise MigrationControlError('请选择一种交付方式', 400)
    if (basic_scoped or verified) and any(item['status'] == 'RUNNING' for item in task['attempts']):
        raise MigrationControlError('任务正在运行，请等待当前操作完成后下载')
    frozen = await service.repository.read_snapshot(identifier, candidate['id'])
    digest = service.judge_identity()
    eligible = verify_delivery(task, frozen, digest)
    run = eligible['run'] if eligible else None
    if verified and not run:
        raise MigrationControlError('当前候选及配置尚未通过所需联合验收')
    if verified:
        issues = input_issues(task, run['configuration'], True)
        if issues:
            raise MigrationControlError('；'.join(issues))
        current = await service.runtime(frozen, run['configuration'], candidate.get('services', []))
        require_binding(task, current['environmentSnapshot'])
        if review_environment(task, current['environmentSnapshot'])['status'] == 'FAILED':
            raise MigrationControlError('运行环境不满足当前方案要求')
        if fingerprint(current['environmentSnapshot']) != fingerprint(run.get('runtimeSnapshot')):
            raise MigrationControlError('运行环境已变化，需要对当前环境重新验收')
    files = {'package/' + name: content for name, content in frozen['files'].items()}
    assert_safe(files)
    def add(name, value):
        files[name] = base64.b64encode(json.dumps(value, ensure_ascii=False, indent=2).encode()).decode()
    add('migration/acceptance.json', run or {'status': 'NOT_VERIFIED'})
    reviews = [item for item in task.get('deliveryReviews', []) if item['candidateId'] == candidate['id'] and item['workspaceDigest'] == candidate['digest']]
    if reviews:
        add('migration/delivery-reviews.json', {'reviews': [{**review, 'scopeCurrent': review.get('scopeDigest') == scope_digest(task),
            'basicEvidenceCurrent': basic_current(task, review, digest)} for review in reviews],
            'note': '基础验证审查仅覆盖其说明的范围；独立源码审查不代表效果评测或最终验收通过。scopeCurrent 表示记录是否对应当前登记的任务范围。'})
    basic = basic_report(task, candidate, frozen, digest)
    add('migration/basic-validation.json', basic['report'])
    if basic_scoped and not basic['approved']:
        raise MigrationControlError('当前版本没有有效的基础验证和独立审查，请先完成或重新验证')
    status = builder_status(task)
    add('migration/manifest.json', {'schemaVersion': task['schemaVersion'], 'candidate': candidate,
        **{key: task[key] for key in ('configuration', 'runtimeSelectionRevision') if key in task}, 'verified': verified and bool(run),
        **({'verificationRates': eligible['rates']} if verified and eligible else {}),
        **({'basicDelivery': {'reviewId': basic['review']['id'], 'scope': basic['review']['basicReview']['scope'],
            'note': '仅交付所述基础验证范围；效果评测与正式验收状态另行记录。'}} if basic_scoped and basic['review'] else {}),
        'builderStatus': status, **({'builderBinding': task['runtimeDelivery']} if status == 'BOUND' else {})})
    effects = [effect_report(task, review, digest) for review in task.get('effectReviews', []) if review['candidateDigest'] == candidate['digest']]
    if effects:
        add('migration/effect-reviews.json', {'reviews': effects, 'note': '独立效果审查仅适用于所列目标、开发集和运行条件，不代表基础验证或正式验收通过。'})
    standardization = (task.get('analysis') or {}).get('standardization')
    if standardization:
        add('migration/standardization.json', {'standard': standardization, **{key: candidate[key] for key in ('tools', 'conformance') if key in candidate},
            **({'independentToolChecks': candidate['contractEvidence']} if 'contractEvidence' in candidate else {}),
            'requirementCoverage': (run or {}).get('requirementCoverage', []), 'verificationScope': {'environment': (run or {}).get('runtimeSnapshot'),
                'crossFramework': 'NOT_VERIFIED', 'note': '仅声明记录中的实际环境及用例结果；单环境通过不等于所有框架均已实测。'}})
    plan = next((item for item in task.get('planRevisions', []) if item['id'] == candidate.get('planRevisionId')), None)
    add('migration/plan.json', plan or {'analysis': task.get('analysis'), 'status': 'LEGACY_RECORD'})
    if task.get('runtimeReview'):
        review = task['runtimeReview']
        add('migration/runtime-review.json', {**review, 'current': review['candidateId'] == candidate['id']
            and review['configurationDigest'] == fingerprint(task.get('configuration')) and review.get('planDigest') == (fingerprint(task['analysis']) if task.get('analysis') else None)
            and review.get('runtimeSelectionRevision') == task.get('runtimeSelectionRevision')})
    if task.get('selectedRuntimeBuildRequestId'):
        request = next((item for item in task.get('runtimeBuildRequests', []) if item['requirements']['requestId'] == task['selectedRuntimeBuildRequestId']), None)
        add('migration/runtime-build-requirements.json', request['requirements'] if request else None)
        if task.get('runtimeDelivery', {}).get('requestId') == task['selectedRuntimeBuildRequestId']:
            add('migration/runtime-build-result.json', task['runtimeDelivery']['result'])
    if (basic_scoped or verified) and fingerprint(await service.repository.get(identifier)) != fingerprint(task):
        raise MigrationControlError('任务状态在下载期间发生变化，请刷新后重试')
    return bundle_zip(files)


async def optimization_workspace(service, identifier, attempt_id):
    task = await service.repository.get(identifier)
    attempt = next((item for item in task['attempts'] if item['id'] == attempt_id), {})
    loop = attempt.get('optimization')
    if not loop:
        raise MigrationControlError('优化任务不存在', 404)
    candidate = (loop.get('waiting') or {}).get('candidate') or loop.get('working') or loop['best']
    frozen = await service.repository.read_snapshot(identifier, candidate['id'])
    metadata = {'candidate': candidate, 'goal': loop['goal'], 'diagnosis': (loop['rounds'] or [{}])[-1].get('diagnosis'), 'requestId': (loop.get('waiting') or {}).get('requestId')}
    return bundle_zip({**frozen['files'], 'optimization-handoff.json': base64.b64encode(json.dumps(metadata, ensure_ascii=False, indent=2).encode()).decode()})
