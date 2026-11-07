"""Check whether a review's basic-validation references identify real evidence.

This validates references and observed outcomes only. The independent reviewer
still judges whether their scope is appropriate for the user's task.
"""


def validate(review, digest, checks, runs):
    if not isinstance(review, dict) or review.get('status') not in ('SUFFICIENT', 'INCOMPLETE'):
        return {'valid': False, 'reason': '基础验证结论无效'}
    scope, reason, refs = review.get('scope'), review.get('reason'), review.get('references')
    if (not isinstance(scope, str) or not scope.strip() or len(scope)>2000 or
            not isinstance(reason, str) or not reason.strip() or len(reason)>4000 or
            not isinstance(refs, list) or len(refs)>30):
        return {'valid': False, 'reason': '基础验证范围、说明或证据引用无效'}
    if review['status']=='SUFFICIENT' and not refs:
        return {'valid': False, 'reason': '基础验证充分的结论需要实际证据'}
    if 'coversTaskScope' in review and not isinstance(review['coversTaskScope'],bool):
        return {'valid':False,'reason':'任务范围覆盖标记无效'}
    if review.get('coversTaskScope') is True and review['status']!='SUFFICIENT':
        return {'valid':False,'reason':'证据不足时不能声明基础验证已覆盖任务范围'}
    indexed_checks = {item.get('receiptId'):item for item in checks if isinstance(item, dict) and isinstance(item.get('receiptId'), str)}
    indexed_runs = {item.get('runId'):item for item in runs if isinstance(item, dict) and isinstance(item.get('runId'), str)}
    seen=set()
    for ref in refs:
        if not isinstance(ref, dict) or set(ref)!={'kind','id'} or ref.get('kind') not in ('project_check','development_run') or not isinstance(ref.get('id'),str) or not ref['id']:
            return {'valid':False,'reason':'基础验证引用无效'}
        key=(ref['kind'],ref['id'])
        if key in seen:
            return {'valid':False,'reason':'基础验证引用重复'}
        seen.add(key)
        if ref['kind']=='project_check':
            item=indexed_checks.get(ref['id'])
            if not item or item.get('snapshotDigest')!=digest:
                return {'valid':False,'reason':'工程检查不存在或不属于当前文件'}
            if review['status']=='SUFFICIENT' and (item.get('status')!='COMPLETED' or type(item.get('exitCode')) is not int or item['exitCode']!=0):
                return {'valid':False,'reason':'工程检查没有成功完成'}
        else:
            item=indexed_runs.get(ref['id'])
            if not item or item.get('phase')!='development' or item.get('candidateDigest')!=digest:
                return {'valid':False,'reason':'开发集运行不存在或不属于当前文件'}
            if review['status']=='SUFFICIENT' and item.get('status')!='PASSED':
                return {'valid':False,'reason':'开发集运行没有通过'}
            if review['status']=='SUFFICIENT' and item.get('matchesCurrentConfiguration') is not True:
                return {'valid':False,'reason':'开发集运行的配置、测试集或评判器已变化'}
    return {'valid':True}


def execute(request):
    return validate(request.get('review'),request.get('digest'),request.get('checks') or [],request.get('runs') or [])
