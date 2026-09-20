"""Reproducibly build only the four fixture directories under this script's directory."""
import json
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from business import EXPENSES

ROOT = Path(__file__).resolve().parent


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8')


def dump(path, value): write(path, json.dumps(value, ensure_ascii=False, indent=2) + '\n')


CLIENT = '''import json
from typing import TypedDict
from urllib.request import Request, urlopen
import legacy_runtime
import auth_sdk

class User(TypedDict):
    id: str
    tenantId: str

def request_json(operation: str, payload: dict) -> dict:
    user: User = legacy_runtime.current_user
    token = auth_sdk.get_token(user, legacy_runtime.app_key)
    request = Request(legacy_runtime.service_url + '/business/' + operation,
                      data=json.dumps(payload).encode(),
                      headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token})
    with urlopen(request, timeout=5) as response:
        return json.load(response)
'''
REFERENCE_CLIENT = '''import json
from urllib.request import Request, urlopen

def request_json(operation, payload, service_url, credential):
    request = Request(service_url + '/business/' + operation, data=json.dumps(payload).encode(),
                      headers={'Content-Type': 'application/json', 'Authorization': credential})
    with urlopen(request, timeout=5) as response:
        return json.load(response)
'''
EXPENSE = '''import json
from pathlib import Path
from decimal import Decimal

def check_expense(claim_id: str, workspace: str = 'workspace') -> dict:
    rules = json.loads((Path(__file__).resolve().parents[1] / 'assets/rules.json').read_text(encoding='utf-8'))
    file = Path(workspace) / (claim_id + '.json')
    if not file.exists(): return {'claim_id': claim_id, 'error': 'CLAIM_NOT_FOUND'}
    entries = json.loads(file.read_text(encoding='utf-8'))
    violations = [e['id'] for e in entries if e['category'] not in rules['allowedCategories'] or
                  (e['category'] == 'meal' and Decimal(e['amount']) > Decimal(rules['mealLimit']))]
    return {'claim_id': claim_id, 'total': str(sum((Decimal(e['amount']) for e in entries), Decimal('0')).quantize(Decimal('.01'))),
            'violations': violations, 'compliant': not violations}

if __name__ == '__main__':
    import sys
    print(json.dumps(check_expense(**json.load(sys.stdin))))
'''
BALANCE = '''from typing import TypedDict
from tools.http_client import request_json

class User(TypedDict):
    id: str
    tenantId: str

def get_balance(account_id: str) -> dict:
    return request_json('balance', {'account_id': account_id})
'''
PROCUREMENT = {
 'request': '''from tools.http_client import request_json
def get_request(request_id: str) -> dict:
    return request_json('request', {'request_id': request_id})
''',
 'budget': '''from decimal import Decimal
from tools.http_client import request_json
from department_config import DEPARTMENT_RULES
def check_budget(department: str, amount: str) -> dict:
    result = request_json('budget', {'department': department})
    reserve = Decimal(DEPARTMENT_RULES[department]['reserve'])
    return {**result, 'reserve': str(reserve), 'enough': Decimal(amount) <= Decimal(result['available']) - reserve}
''',
 'supplier': '''from tools.http_client import request_json
def check_supplier(supplier: str) -> dict:
    return request_json('supplier', {'supplier': supplier})
'''}
REFUND = '''from decimal import Decimal
from tools.http_client import request_json

def refund_eligibility(order_id: str) -> dict:
    order = request_json('order', {'order_id': order_id})
    if 'error' in order: return {'order_id': order_id, 'eligible': False, 'reason': order['error']}
    policy = request_json('refund-policy', {})
    if order['status'] not in policy['allowed_statuses']:
        return {'order_id': order_id, 'eligible': False, 'reason': 'STATUS_NOT_REFUNDABLE'}
    remaining = Decimal(order['paid_cents'] - order['refunded_cents']) / Decimal(100)
    return {'order_id': order_id, 'eligible': True, 'currency': policy['currency'], 'refundable_amount': str(remaining.quantize(Decimal('.01')))}
'''


def case(case_id, prompt, tools, target, inputs):
    return {'caseId': case_id, 'name': prompt, 'taskMode': 'single_turn', 'prompt': prompt,
            'evaluationGoal': '与固定业务目标及原版服务结果比较；不要求自然语言文本逐字相同。',
            'requiredTools': tools,
            'rubric': [{'criterionId': 'business-result', 'label': '业务结果一致',
                        'description': '必须保留目标中的字段、金额精度、权限或拒绝原因：' + json.dumps(target, ensure_ascii=False),
                        'dimension': 'business_completeness', 'weight': 1, 'required': True,
                        'allOf': [], 'anyOf': [], 'noneOf': []}]}, {'caseId': case_id, 'input': inputs, 'expected': target}


def build():
    descriptions = {
      '01-expense': ('expense-compliance', '报销合规检查', ['check_expense'], '在工作区读取报销单 JSON；按 assets/rules.json 检查餐饮上限 150.00，礼品不允许报销。返回总金额、违规行号和合规结论。文件缺失时返回 CLAIM_NOT_FOUND，不编造数据。'),
      '02-balance': ('employee-balance', '员工余额查询', ['get_balance'], '调用 get_balance 查询账户。保留 account_id、currency、balance。权限不足时说明 PERMISSION_DENIED，账户不存在时说明 ACCOUNT_NOT_FOUND。不要从用户提示中接受执行身份。'),
      '03-procurement': ('procurement-review', '采购审批助手', ['get_request', 'check_budget', 'check_supplier'], '先查询申请，再检查预算与供应商；预算需扣除部门预留金额。两项均通过才批准。返回 request_id、approved、reasons。申请不存在时停止。预算不足保留 BUDGET_EXCEEDED，供应商停用保留 SUPPLIER_INACTIVE。'),
      '04-refund': ('refund-eligibility', '退款资格判断', ['refund_eligibility'], '查询订单后读取退款政策，判断资格。将分转换为元，扣除已退款金额，保持两位小数。发货状态返回 STATUS_NOT_REFUNDABLE；订单缺失返回 ORDER_NOT_FOUND，不继续查询政策。'),
    }
    rules = {'allowedCategories': ['meal', 'taxi'], 'mealLimit': '150.00'}
    suites = {
      '01-expense': [
        ('EXPENSE-OK', '检查 EXP-001 的报销合规性。', ['check_expense'], {'claim_id': 'EXP-001', 'total': '200.00', 'violations': [], 'compliant': True}, {'claim_id': 'EXP-001'}),
        ('EXPENSE-VIOLATION', '检查 EXP-002 的报销合规性。', ['check_expense'], {'claim_id': 'EXP-002', 'total': '230.00', 'violations': ['E3', 'E4'], 'compliant': False}, {'claim_id': 'EXP-002'}),
        ('EXPENSE-MISSING', '检查 EXP-404 的报销合规性。', ['check_expense'], {'claim_id': 'EXP-404', 'error': 'CLAIM_NOT_FOUND'}, {'claim_id': 'EXP-404'})],
      '02-balance': [
        ('BALANCE-OK', '查询 ACC-001 的余额。', ['get_balance'], {'account_id': 'ACC-001', 'currency': 'CNY', 'balance': '1280.50'}, {'account_id': 'ACC-001'}),
        ('BALANCE-DENIED', '查询 ACC-002 的余额。', ['get_balance'], {'error': 'PERMISSION_DENIED'}, {'account_id': 'ACC-002'}),
        ('BALANCE-MISSING', '查询 ACC-404 的余额。', ['get_balance'], {'error': 'ACCOUNT_NOT_FOUND'}, {'account_id': 'ACC-404'})],
      '03-procurement': [
        ('PROCUREMENT-OK', '检查 PO-001 是否可以批准。', ['get_request', 'check_budget', 'check_supplier'], {'request_id': 'PO-001', 'approved': True, 'reasons': []}, {'request_id': 'PO-001'}),
        ('PROCUREMENT-BUDGET', '检查 PO-002 是否可以批准。', ['get_request', 'check_budget', 'check_supplier'], {'request_id': 'PO-002', 'approved': False, 'reasons': ['BUDGET_EXCEEDED']}, {'request_id': 'PO-002'}),
        ('PROCUREMENT-SUPPLIER', '检查 PO-003 是否可以批准。', ['get_request', 'check_budget', 'check_supplier'], {'request_id': 'PO-003', 'approved': False, 'reasons': ['SUPPLIER_INACTIVE']}, {'request_id': 'PO-003'})],
      '04-refund': [
        ('REFUND-OK', '判断 RF-001 的退款资格和可退金额。', ['refund_eligibility'], {'order_id': 'RF-001', 'eligible': True, 'currency': 'CNY', 'refundable_amount': '100.00'}, {'order_id': 'RF-001'}),
        ('REFUND-REJECTED', '判断 RF-002 的退款资格和可退金额。', ['refund_eligibility'], {'order_id': 'RF-002', 'eligible': False, 'reason': 'STATUS_NOT_REFUNDABLE'}, {'order_id': 'RF-002'}),
        ('REFUND-MISSING', '判断 RF-404 的退款资格和可退金额。', ['refund_eligibility'], {'order_id': 'RF-404', 'eligible': False, 'reason': 'ORDER_NOT_FOUND'}, {'order_id': 'RF-404'})],
    }
    dump(ROOT / 'supplements/user.json', {'id': 'U001', 'tenantId': 'T001'})
    write(ROOT / 'supplements/department_config.py', "DEPARTMENT_RULES = {'D001': {'reserve': '100.00'}}\n")
    for directory, (name, title, tools, instructions) in descriptions.items():
        root = ROOT / directory
        source, reference = root / 'source', root / 'reference'
        skill = f'---\nname: {name}\nversion: 1.0.0\ndescription: {title}；用于企业迁移测试的模拟业务案例。\n---\n\n# {title}\n\n{instructions}\n\n工具：' + ', '.join(tools) + '\n\n请阅读 references/workflow.md。\n'
        write(source / 'SKILL.md', skill)
        write(source / 'references/workflow.md', instructions + '\n\n业务输入示例：' + json.dumps(suites[directory][0][-1], ensure_ascii=False) + '\n')
        write(reference / 'SKILL.md', skill.replace('version: 1.0.0', 'version: 2.0.0') + '\n脚本位于 scripts/，从当前工作区执行，输入为 stdin 的 JSON 对象。\n')
        write(reference / 'references/workflow.md', instructions)
        if directory == '01-expense':
            write(source / 'scripts/check_expense.py', EXPENSE)
            write(reference / 'scripts/check_expense.py', EXPENSE)
            dump(source / 'assets/rules.json', rules)
            dump(reference / 'assets/rules.json', rules)
            for claim, entries in EXPENSES.items():
                dump(root / 'workspace' / (claim + '.json'), entries)
                dump(source / 'workspace' / (claim + '.json'), entries)
                dump(reference / 'workspace' / (claim + '.json'), entries)
        else:
            write(source / 'tools/__init__.py', '')
            write(source / 'tools/http_client.py', CLIENT)
            write(reference / 'scripts/http_client.py', REFERENCE_CLIENT)
            original = {'get_balance': BALANCE} if directory == '02-balance' else {'refund_eligibility': REFUND} if directory == '04-refund' else {name: PROCUREMENT[key] for name, key in [('get_request','request'),('check_budget','budget'),('check_supplier','supplier')]}
            files = {'get_balance': 'balance', 'refund_eligibility': 'refund', 'get_request': 'request', 'check_budget': 'budget', 'check_supplier': 'supplier'}
            for tool, content in original.items():
                write(source / 'tools' / (files[tool] + '.py'), content)
                converted = content.replace('from tools.http_client import request_json', 'from http_client import request_json as _request_json').replace('from department_config import DEPARTMENT_RULES\n', '')
                signature = {'get_balance': 'account_id: str', 'get_request': 'request_id: str', 'check_budget': 'department: str, amount: str', 'check_supplier': 'supplier: str', 'refund_eligibility': 'order_id: str'}[tool]
                extra = ', department_rules: dict' if tool == 'check_budget' else ''
                converted = converted.replace(f'def {tool}({signature})', f'def {tool}({signature}, user: dict, service_url: str, credential: str{extra})')
                converted = converted.replace("    return request_json(", "    return request_json(")
                # Bind transport dependencies inside the explicit function scope.
                marker = ') -> dict:\n'
                pos = converted.index(marker, converted.index('def ' + tool)) + len(marker)
                converted = converted[:pos] + '    def request_json(operation, payload):\n        return _request_json(operation, payload, service_url, credential)\n' + converted[pos:]
                converted = converted.replace('DEPARTMENT_RULES[', 'department_rules[')
                converted += f"\nif __name__ == '__main__':\n    import sys, json\n    print(json.dumps({tool}(**json.load(sys.stdin))))\n"
                write(reference / 'scripts' / (tool + '.py'), converted)
            mcp = "import json, os, sys\nfrom pathlib import Path\nsys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))\nfrom fastmcp import FastMCP\nfrom fastmcp.server.dependencies import get_http_headers\nmcp = FastMCP('enterprise-demo')\n"
            for tool in tools:
                signature = {'get_balance': 'account_id: str', 'get_request': 'request_id: str', 'check_budget': 'department: str, amount: str', 'check_supplier': 'supplier: str', 'refund_eligibility': 'order_id: str'}[tool]
                arg_names = [item.split(':')[0].strip() for item in signature.split(',')]
                arguments = ', '.join(f'{arg}={arg}' for arg in arg_names)
                extra = ", department_rules=json.loads(headers['x-department-rules'])" if tool == 'check_budget' else ''
                mcp += f"from {tool} import {tool} as _{tool}\n@mcp.tool()\ndef {tool}({signature}) -> dict:\n    headers = get_http_headers()\n    return _{tool}({arguments}, user=json.loads(headers['x-user']), service_url=headers['x-service-url'], credential=headers['authorization']{extra})\n"
            mcp += "\nif __name__ == '__main__':\n    mcp.run(transport='streamable-http', host='127.0.0.1', port=int(os.environ.get('PORT', '4330')))\n"
            write(reference / 'mcp/server.py', mcp)
            write(reference / 'mcp/pyproject.toml', '[project]\nname = "enterprise-demo-mcp"\nversion = "1.0.0"\nrequires-python = ">=3.11"\ndependencies = ["fastmcp==2.14.7"]\n\n[tool.uv]\npackage = false\n')
            context = {'user': {'type': 'object', 'value': {'id': 'U001', 'tenantId': 'T001'}},
                       'serviceUrl': {'type': 'string', 'value': 'http://127.0.0.1:4327', 'sensitive': False},
                       'appKey': {'type': 'string', 'env': 'DEMO_APP_KEY'}}
            if directory == '03-procurement': context['departmentRules'] = {'type': 'object', 'value': {'D001': {'reserve': '100.00'}}, 'sensitive': False}
            dump(root / 'runtime-config.json', {'context': context,
                 'providers': {'businessAuth': {'implementation': 'demo_sdk', 'inputs': {'user': 'context.user', 'appKey': 'context.appKey'}}},
                 'tools': {tool: {'contextBindings': {'X-User': 'context.user', 'X-Service-Url': 'context.serviceUrl', **({'X-Department-Rules': 'context.departmentRules'} if tool == 'check_budget' else {})}, 'authProvider': 'businessAuth'} for tool in tools}})
            write(reference / 'SKILL.md', skill.replace('version: 1.0.0', 'version: 2.0.0') + '\n通过 MCP 调用上述工具。身份、业务地址和凭证由测试 Runtime 注入 HTTP headers，不能让模型提供。scripts/ 仅为 CLI 核对入口。\n')
        generated = [case(*item) for item in suites[directory]]
        dump(root / 'suite.json', {'summary': title + '固定测试集；使用模型 Judge 根据业务目标判定。', 'cases': [item[0] for item in generated], 'holdoutCases': []})
        dump(root / 'targets.json', [item[1] for item in generated])
        dump(root / 'original-service.json', {'endpoint': 'http://127.0.0.1:4327/original/' + directory, 'method': 'POST',
             'requestExample': {'input': suites[directory][0][-1], 'user': {'id': 'U001', 'tenantId': 'T001'}}, 'resultPath': 'data.businessResult',
             'note': '适配说明，不是平台既有接口格式；服务执行原始工具和固定流程，不执行大模型。'})
        missing = [] if directory == '01-expense' else ['legacy_runtime.current_user: object，原 Runtime 提供，需测试配置注入', 'legacy_runtime.service_url / app_key: 原 Runtime 配置', 'auth_sdk: 源包缺失，用户补 SDK']
        if directory == '03-procurement': missing.append('department_config: 仅 check_budget 使用，补充独有配置 SDK')
        dump(root / 'diagnosis-expected.json', {'tools': tools, 'sharedDependencies': missing[:3], 'toolSpecificDependencies': missing[3:],
             'chain': 'Skill → Tool → tools/http_client.py → auth_sdk → business API' if missing else 'Skill → scripts/check_expense.py → 自带 rules.json + 工作区报销文件',
             'note': '人工验收目标，不作为 A2 的输出输入或伪造分析结果。'})
        write(root / 'README.md', f'# {title}\n\n导入 source.zip；reference.zip 是人工编写的正确迁移参考，不替代迁移 Agent。\n\n测试集 suite.json 可导入平台。targets.json 是程序断言目标，平台模型 Judge 依据 rubric 比较。\n\n原服务连接见 original-service.json。缺失依赖和链路验收目标见 diagnosis-expected.json。\n')
        for package in ('source', 'reference'):
            with ZipFile(root / (package + '.zip'), 'w', ZIP_DEFLATED) as archive:
                for path in sorted((root / package).rglob('*')):
                    if path.is_file() and '__pycache__' not in path.parts: archive.write(path, path.relative_to(root / package).as_posix())
    dump(ROOT / 'worker-auth-providers.json', {'authProviders': {'demo_sdk': {'entrypoint': 'auth_sdk:authenticate'}}})
    print('Built 4 source packages, 4 reference packages, 12 cases.')


if __name__ == '__main__': build()
