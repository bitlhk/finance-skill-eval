"""Prepare bounded, change-focused evidence for independent effect review."""
import base64
import difflib
import re

_SENSITIVE = re.compile(r'(?i)(?:api[_-]?key|password|secret|token|credential)\s*["\']?\s*[:=]\s*["\'][^"\'\r\n]+["\']')
_PRIVATE_KEY = re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----')
_AUTH_URL = re.compile(r'(?i)\b[a-z][a-z0-9+.-]*://[^\s/@:]+:[^\s/@]+@')


def execute(request):
    result = []
    for item in request['changes']:
        name = item['path']
        row = {'path': name, 'reason': item['reason']}
        if re.search(r'(^|/)\.env(?:\.|$)|\.(?:pem|key)$', name, re.I):
            row['reason'] += '；配置文件内容已隐藏，请结合运行证据审查'
            result.append(row)
            continue
        try:
            before = base64.b64decode(item.get('before', ''), validate=True).decode('utf-8')
            after = base64.b64decode(item.get('after', ''), validate=True).decode('utf-8')
        except (ValueError, UnicodeError):
            row['reason'] += '；非文本文件，未提供内容'
            result.append(row)
            continue
        if any(pattern.search(text) for pattern in (_SENSITIVE, _PRIVATE_KEY, _AUTH_URL) for text in (before, after)):
            row['reason'] += '；文件可能包含凭据，内容已隐藏'
            result.append(row)
            continue
        diff = ''.join(difflib.unified_diff(before.splitlines(keepends=True), after.splitlines(keepends=True),
                                             fromfile='before', tofile='after', n=4))
        if len(diff) > 12000:
            diff = diff[:12000] + '\n[差异过长，已截断；不能据此判断未展示的部分]\n'
        row['after'] = '以下为变更附近的统一差异，并非完整文件：\n' + diff
        result.append(row)
    return result
