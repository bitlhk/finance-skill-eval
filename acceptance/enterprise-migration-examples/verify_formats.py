"""Validate enterprise fixtures against the platform's published contracts."""
import json
from pathlib import Path
import re
from api.contracts import parse


root = Path(__file__).resolve().parent
for directory in sorted(root.iterdir()):
    if directory.is_dir() and re.match(r'^0[1-4]-', directory.name):
        parse('manual_preparation', json.loads((directory / 'suite.json').read_text(encoding='utf-8')))
        parse('runtime_tool_configuration', json.loads((directory / 'runtime-config.json').read_text(encoding='utf-8')))
expense = (root / '01-expense/source/scripts/check_expense.py').read_text(encoding='utf-8')
assert not re.search(r'agentscope|Toolkit|build_toolkit', expense)
procurement = (root / '03-procurement/source/SKILL.md').read_text(encoding='utf-8')
for phrase in ['## 输入', '## 审批流程', '## 工具职责', '## 输出', 'BUDGET_EXCEEDED', 'SUPPLIER_INACTIVE']:
    assert phrase in procurement
print('4 suites and 4 Runtime configurations match current platform schemas.')
