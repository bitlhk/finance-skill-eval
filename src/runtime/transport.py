"""Bounded HTTP/SSE transport, named to avoid shadowing Python's stdlib http."""
import json
from urllib.parse import urljoin, urlsplit

import httpx


class RemoteError(RuntimeError):
    def __init__(self, message, *, code=None, status=None, metadata=None):
        super().__init__(message)
        self.code, self.status, self.metadata = code, status, metadata or {}


def controlled_url(base, endpoint):
    target = urljoin(base, endpoint)
    source, destination = urlsplit(base), urlsplit(target)
    def origin(value):
        return value.scheme, value.hostname, value.port or (443 if value.scheme == 'https' else 80)
    if origin(source) != origin(destination) or not destination.path.startswith(source.path):
        raise ValueError('Runtime Launcher endpoint escaped its registered origin or base path')
    if destination.username or destination.password or destination.fragment:
        raise ValueError('Runtime endpoint contains credentials or fragment')
    return target


async def bounded_json(response, limit=262144, label='Runtime response'):
    declared = response.headers.get('content-length', '')
    if declared.isdigit() and int(declared) > limit:
        raise RemoteError(f'{label} exceeds {limit} bytes')
    chunks = bytearray()
    async for chunk in response.aiter_bytes():
        chunks.extend(chunk)
        if len(chunks) > limit:
            raise RemoteError(f'{label} exceeds {limit} bytes')
    return json.loads(chunks)


async def sse_events(response, *, frame_limit=524288):
    pending = bytearray()
    async for chunk in response.aiter_bytes():
        for byte in chunk:
            pending.append(byte)
            delimiter = 4 if pending.endswith(b'\r\n\r\n') else 2 if pending.endswith(b'\n\n') else 0
            if delimiter:
                frame = bytes(pending[:-delimiter]).decode('utf-8', errors='strict').replace('\r\n', '\n')
                pending.clear()
                data = '\n'.join(line[5:].lstrip() for line in frame.split('\n') if line.startswith('data:'))
                if data:
                    yield json.loads(data)
            elif len(pending) > frame_limit:
                raise RemoteError(f'SSE frame exceeds {frame_limit} bytes')
    if pending.strip():
        raise RemoteError('SSE stream ended with an unfinished frame')


def client(timeout=60, **kwargs):
    # No redirects: credentials and uploaded engineering assets must stay at the
    # registered endpoint. httpx retains the operator's proxy configuration.
    return httpx.AsyncClient(timeout=httpx.Timeout(timeout), follow_redirects=False, **kwargs)


async def require_success(response, label='Runtime Launcher'):
    if response.is_success:
        return
    try:
        payload = await bounded_json(response, 65536, label + ' error')
        code = payload.get('error') if isinstance(payload, dict) else None
    except (ValueError, RemoteError):
        code = None
    if not isinstance(code, str) or not code.replace('_', '').isalnum() or len(code) > 80:
        code = None
    raise RemoteError(f'{label} HTTP {response.status_code}' + (f': {code}' if code else ''),
                      code=code, status=response.status_code)
