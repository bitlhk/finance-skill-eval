"""Cross-field execution admission in addition to the shared data contracts."""
import json
from urllib.parse import urlsplit
from api.contracts import parse
from tasks.values import fingerprint


def run_configuration(value):
    value = parse('run_configuration', value)
    def require(condition, reason):
        if not condition:
            raise ValueError(reason)
    require(len(set(value['selectedCaseIds'])) == len(value['selectedCaseIds']), '选择的评测案例不能重复')
    require(not (value.get('executionRepetitions', 1) > 1 and value['runtime']['type'] == 'replay'), '冻结证据回放不能作为重复业务运行')
    require((value['evaluationMode'] == 'service_comparison') == bool(value.get('originalService')), '原服务对比模式必须配置原服务，其他模式不能附带原服务配置')
    managed = value['runtime']['type'] == 'runtime_launcher'
    comparison = value['evaluationMode'] == 'candidate_runtime_comparison'
    if comparison:
        require(bool(value.get('runtimeBindings') and managed and value['judgeMode'] == 'model' and all(value.get(key) for key in (
            'executionModel', 'leftExecutionModel', 'rightExecutionModel', 'leftVariant', 'rightVariant'))), '跨 Runtime 对照需要明确候选、执行模型和左右环境')
        require(fingerprint(value['executionModel']) == fingerprint(value['leftExecutionModel']) and fingerprint(value['leftExecutionModel']['parameters']) == fingerprint(value['rightExecutionModel']['parameters'])
            and fingerprint(value['leftVariant']) == fingerprint(value['rightVariant']) and value['leftVariant']['mode'] == 'skill_version' and value['leftVariant'].get('artifactSha256')
            and value['runtimeBindings']['left']['skillAssetId'] == value['runtimeBindings']['right']['skillAssetId']
            and value['runtimeBindings']['left']['environmentId'] != value['runtimeBindings']['right']['environmentId']
            and value['runtime']['environmentId'] == value['runtimeBindings']['left']['environmentId'], '跨 Runtime 对照需要同一冻结候选、参数和不同环境，主模型与 Launcher 对应左侧')
    if value['evaluationMode'] == 'solution_comparison':
        require(value.get('runtimeBindings') and managed and value['caseSource'] == 'fixed', '整套方案对比需要固定测试集和左右 Launcher 绑定')
    if value['evaluationMode'] == 'service_comparison':
        require(value.get('runtimeBindings') and managed and value['judgeMode'] == 'model' and value['caseSource'] == 'fixed' and value.get('preparationId') and not value['includeHoldout'], '原服务对比需要固定测试集、模型评估和显式候选 Runtime 绑定')
    require(not value.get('runtimeToolConfig') or managed, 'Runtime context requires a managed Runtime environment')
    if value.get('runtimeBindings'):
        require(managed and value['caseSource'] == 'fixed' and value.get('executionModel') and all(value.get(side + 'Variant', {}).get('mode') == 'skill_version' for side in ('left', 'right')), 'Paired migration requires a Runtime Launcher, explicit Skill versions, fixed cases and the same execution model.')
        if not comparison and value['evaluationMode'] != 'solution_comparison':
            require(all(not value.get(side + 'ExecutionModel') or fingerprint(value[side + 'ExecutionModel']) == fingerprint(value['executionModel']) for side in ('left', 'right')), 'Paired migration requires the same execution model')
    if value['caseSource'] == 'ai_generated':
        require(value['runtime']['type'] != 'replay' and not value.get('preparationId') and not value['includeHoldout'] and not value['selectedCaseIds'] and value['judgeMode'] == 'model', '动态出题需要在线执行与模型 Judge，不能混用回放、已准备题集、固定题选择或留出集。')
    require(bool(value.get('packId')) != bool(value.get('preparationId')), 'Exactly one of packId or preparationId is required')
    if value.get('originalService'):
        service = value['originalService']
        parsed = urlsplit(service['endpoint'])
        require(parsed.scheme in ('http', 'https') and parsed.hostname and not parsed.username and not parsed.password and not parsed.fragment, '请输入不含账号、密码或片段的 HTTP 服务地址')
        require(not service['responsePointer'] or service['responsePointer'].startswith('/'), '返回字段使用 JSON Pointer')
        require(service['responseFormat'] != 'text' or not service['responsePointer'], '纯文本响应不需要填写返回字段')
        require('{{input}}' in json.dumps(service['requestTemplate'], ensure_ascii=False), '请求模板必须包含 {{input}}')
        names = [header['name'].lower() for header in service['headers']]
        require(len(set(names)) == len(names) and all('\r' not in header['prefix'] and '\n' not in header['prefix'] for header in service['headers']), '请求头名称重复或前缀包含无效字符')
    return value
