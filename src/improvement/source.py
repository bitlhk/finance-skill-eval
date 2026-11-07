"""Safe code evidence and editing guards shared by standalone optimization."""
import base64
from copy import deepcopy
import re
import yaml

from assets.export import assert_safe, ExportError
from assets.snapshot import SourceLoader


def source_evidence(files):
    texts, omitted = [], []
    for name in sorted(files, key=lambda name: (not bool(re.search(r'(^|/)skill\.md$', name, re.I)), name)):
        try:
            content = base64.b64decode(files[name], validate=True).decode('utf-8')
            if '\0' in content:
                raise ValueError('binary')
        except (ValueError, UnicodeError):
            omitted.append({'path': name, 'reason': 'binary'})
            continue
        try:
            assert_safe({name: files[name]})
        except ExportError:
            omitted.append({'path': name, 'reason': 'sensitive'})
            continue
        texts.append({'origin': 'candidate', 'path': name, 'content': content})
    return {'files': texts, 'omitted': omitted}


def version_entry(files, entry, version):
    files = deepcopy(files)
    text = base64.b64decode(files[entry], validate=True).decode('utf-8')
    match = re.match(r'^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))', text)
    if not match:
        return files
    metadata = yaml.load(match[2], Loader=SourceLoader)
    if not isinstance(metadata, dict):
        raise ValueError('候选 Skill 元数据无效')
    metadata['version'] = version
    ending = '\r\n' if '\r\n' in match[1] else '\n'
    body = yaml.safe_dump(metadata, allow_unicode=True, sort_keys=False).rstrip('\n').replace('\n', ending)
    files[entry] = base64.b64encode((match[1] + body + match[3] + text[match.end():]).encode()).decode()
    return files


def changes(before, after):
    return [{'path': name, 'before': base64.b64decode(before.get(name, '')).decode('utf-8', errors='replace'),
        'after': base64.b64decode(after.get(name, '')).decode('utf-8', errors='replace'), 'reason': '主 Agent 根据开发集证据调整'}
        for name in sorted(set(before) | set(after)) if before.get(name) != after.get(name)]
