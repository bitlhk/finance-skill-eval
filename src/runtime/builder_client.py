"""Client for the existing private Runtime Builder delivery API.

The caller owns task persistence and delivery admission. This module never logs
request bodies or credentials and does not treat a successful build as validation.
"""
import json
import re
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class BuilderError(RuntimeError):
    pass


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class BuilderClient:
    def __init__(self, base_url, token, timeout=30):
        parsed = urlsplit(base_url)
        if (parsed.scheme not in ('http', 'https') or not parsed.hostname or
                parsed.username or parsed.password or parsed.query or parsed.fragment):
            raise ValueError('Builder 地址无效')
        if parsed.scheme == 'http' and parsed.hostname not in ('localhost', '127.0.0.1', '::1'):
            raise ValueError('远程 Builder 必须使用 HTTPS')
        if not token or not token.strip():
            raise ValueError('Builder 凭据未配置')
        self._base = urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip('/') + '/', '', ''))
        self._authorization = token if token.startswith('Bearer ') else 'Bearer ' + token
        self._timeout = timeout
        self._opener = build_opener(_NoRedirect())

    def _request(self, method, suffix, body=None, key=None):
        headers = {'Authorization': self._authorization, 'Accept': 'application/json'}
        data = None
        if body is not None:
            data = json.dumps(body, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
            headers['Content-Type'] = 'application/json'
        if key:
            headers['Idempotency-Key'] = key
        request = Request(self._base + 'v1/runtime-builds' + suffix, data=data, headers=headers, method=method)
        try:
            with self._opener.open(request, timeout=self._timeout) as response:
                payload = response.read(2_097_153)
                if len(payload) > 2_097_152:
                    raise BuilderError('Builder 返回数据超过大小限制')
                value = json.loads(payload)
        except HTTPError as exc:
            try:
                failure = json.loads(exc.read(16384))
                code = failure.get('code') or failure.get('error')
                if code == 'DEPLOYMENT_REBUILD_REQUIRED':
                    raise BuilderError('当前 Builder 接口不支持 Runtime 重建，已保留诊断，需由外部完成重建') from None
                if isinstance(code, str) and re.fullmatch(r'[A-Z][A-Z0-9_]{1,79}', code):
                    raise BuilderError(f'Builder 请求未通过（{code}）') from None
            except (ValueError, TypeError, AttributeError):
                pass
            raise BuilderError(f'Builder 请求失败（HTTP {exc.code}）') from None
        except (URLError, TimeoutError, OSError, ValueError) as exc:
            raise BuilderError(f'Builder 请求未完成（{type(exc).__name__}）') from None
        if not isinstance(value, dict):
            raise BuilderError('Builder 返回格式无效')
        return value

    def submit(self, requirements, instance_request, idempotency_key):
        if not idempotency_key or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,200}', idempotency_key):
            raise ValueError('Builder 幂等标识无效')
        return self._request('POST', '', {'requirements': requirements, 'instanceRequest': instance_request}, idempotency_key)

    def get(self, build_id):
        return self._request('GET', '/' + self._build_id(build_id))

    def cancel(self, build_id):
        return self._request('DELETE', '/' + self._build_id(build_id))

    async def invoke(self, action, *, requirements=None, instance_request=None, idempotency_key=None, build_id=None):
        """Native async service path; closing/cancellation closes the HTTP request."""
        from runtime.transport import client, bounded_json, require_success, RemoteError
        if action == 'submit':
            if not idempotency_key or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,200}', idempotency_key):
                raise ValueError('Builder 幂等标识无效')
            method, suffix = 'POST', ''
            body = {'requirements': requirements, 'instanceRequest': instance_request}
        elif action in ('get', 'cancel'):
            method, suffix, body = ('GET' if action == 'get' else 'DELETE'), '/' + self._build_id(build_id), None
        else:
            raise ValueError('未知 Builder 操作')
        headers = {'Authorization': self._authorization, 'Accept': 'application/json'}
        if idempotency_key:
            headers['Idempotency-Key'] = idempotency_key
        try:
            async with client(360 if action == 'get' else 30) as http:
                async with http.stream(method, self._base + 'v1/runtime-builds' + suffix, headers=headers,
                        **({'json': body} if body is not None else {})) as response:
                    await require_success(response, 'Builder')
                    value = await bounded_json(response, 2097152, 'Builder')
            if not isinstance(value, dict):
                raise BuilderError('Builder 返回格式无效')
            return value
        except RemoteError as error:
            if error.code == 'DEPLOYMENT_REBUILD_REQUIRED':
                raise BuilderError('当前 Builder 接口不支持 Runtime 重建，已保留诊断，需由外部完成重建') from None
            raise BuilderError(str(error)) from None

    @staticmethod
    def _build_id(value):
        if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,200}', value):
            raise ValueError('Builder 构建标识无效')
        return value
