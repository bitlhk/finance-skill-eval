"""Package frozen files while preserving the existing credential gate."""
import base64
import io
import re
import zipfile


class ExportError(ValueError):
    status = 409
    code = 'MIGRATION_EXPORT_CREDENTIALS'


def assert_safe(files):
    for name, content in files.items():
        text = base64.b64decode(content, validate=True).decode('utf-8', errors='replace')
        template = bool(re.search(r'(^|/)\.env\.example$', name, re.I))
        unsafe_template = False
        if template:
            for line in text.splitlines():
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                assignment = re.fullmatch(r'(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*', line)
                if not assignment or re.search(r'(?:^|_)(?:api_?key|key|password|secret|token|credential)(?:_|$)', assignment[1], re.I) and assignment[2] not in ('', "''", '""'):
                    unsafe_template = True
        fixture = bool(re.search(r'(^|/)tests?/', name, re.I))
        credentials = [match[1] for match in re.finditer(r'''(?:api[_-]?key|password|secret|token)["']?\s*[:=]\s*["']([^"'\n]{8,})["']''', text, re.I)]
        contains_credentials = any(not (fixture and re.fullmatch(r'(?:test(?:-[a-z]{1,16}){0,3}-key|local-test-only)', value)) for value in credentials)
        if ((not template and re.search(r'(^|/)(\.env(?:\..*)?|access-token|id_rsa|id_ed25519)$|\.(pem|key)$', name, re.I))
                or unsafe_template or re.search(r'\b[a-z][a-z0-9+.-]*://[^\s/@:]+:[^\s/@]+@', text, re.I)
                or re.search(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----', text, re.I) or contains_credentials):
            raise ExportError('文件 ' + name + ' 可能包含凭据，请先检查并移除敏感配置；未导出任何文件')


def bundle_zip(files):
    assert_safe(files)
    result = io.BytesIO()
    with zipfile.ZipFile(result, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, base64.b64decode(content, validate=True))
    return result.getvalue()
