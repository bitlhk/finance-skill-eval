"""Bounded stateless transport for the fixed synthetic reference, not uploaded code."""
import argparse
import asyncio
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import re
import time


class SourceLimit(Exception):
    pass


class BoundedMcpApp:
    def __init__(self, app, *, timeout=10.0, grace=1.0, concurrency=4,
                 observe=lambda event: None, fatal=lambda: os._exit(70)):
        if not all(math.isfinite(n) and 0 < n <= 30 for n in (timeout, grace)):
            raise ValueError('SOURCE_TIMEOUT_INVALID')
        if type(concurrency) is not int or not 1 <= concurrency <= 16:
            raise ValueError('SOURCE_CONCURRENCY_INVALID')
        self.app, self.timeout, self.grace = app, timeout, grace
        self.concurrency, self.observe, self.fatal = concurrency, observe, fatal
        self.active = 0

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)

        async def reject(status):
            await send({'type': 'http.response.start', 'status': status,
                        'headers': [(b'content-type', b'application/json')]})
            await send({'type': 'http.response.body', 'body': b'{"error":"SOURCE_REQUEST_REJECTED"}'})

        if scope['path'] != '/mcp' or scope['method'] != 'POST':
            return await reject(405)
        headers = scope['headers']
        if sum(len(k)+len(v) for k, v in headers) > 16384:
            return await reject(431)
        if any(k.lower() in (b'mcp-session-id', b'content-encoding') for k, _ in headers):
            return await reject(400)
        lengths = [v for k, v in headers if k.lower() == b'content-length']
        if lengths and (len(lengths) != 1 or not lengths[0].isdigit() or int(lengths[0]) > 65536):
            return await reject(413)
        if self.active >= self.concurrency:
            return await reject(429)
        self.active += 1
        started = time.monotonic()
        received = sent = 0
        response_started = False
        outcome = 'ERROR'

        async def limited_receive():
            nonlocal received
            message = await receive()
            received += len(message.get('body', b''))
            if received > 65536:
                raise SourceLimit('REQUEST_SIZE')
            return message

        async def limited_send(message):
            nonlocal sent, response_started
            if message['type'] == 'http.response.start':
                if any(k.lower() == b'mcp-session-id' for k, _ in message.get('headers', [])):
                    raise SourceLimit('STATEFUL_RESPONSE')
                response_started = True
            sent += len(message.get('body', b''))
            if sent > 262144:
                raise SourceLimit('RESPONSE_SIZE')
            await send(message)

        task = asyncio.create_task(self.app(scope, limited_receive, limited_send))
        try:
            done, _ = await asyncio.wait({task}, timeout=self.timeout)
            if not done:
                outcome = 'TIMEOUT'
            else:
                task.result()
                outcome = 'RETURNED'
        except asyncio.CancelledError:
            outcome = 'CANCELLED'
            raise
        except SourceLimit as failure:
            outcome = str(failure)
        finally:
            if not task.done():
                task.cancel()
                done, _ = await asyncio.wait({task}, timeout=self.grace)
                if not done:
                    # This dedicated source has no user data or child processes.
                    # A wedged cleanup must not leave an unbounded background call.
                    self.fatal()
                    raise RuntimeError('SOURCE_FAIL_STOP_REQUIRED')
            if task.done() and not task.cancelled():
                task.exception()
            self.active -= 1
            try:
                self.observe({'outcome': outcome, 'requestBytes': received, 'responseBytes': sent,
                              'elapsedMs': round((time.monotonic()-started)*1000), 'active': self.active})
            except Exception:
                pass
        if outcome != 'RETURNED':
            if not response_started:
                return await reject(504 if outcome == 'TIMEOUT' else 502)
            raise RuntimeError('SOURCE_RESPONSE_INCOMPLETE')


def verify_identity(manifest_path, expected_sha256):
    """Startup pins are reviewed deployment inputs, never learned from a live server."""
    raw = Path(manifest_path).read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if not isinstance(expected_sha256, str) or not re.fullmatch('[a-f0-9]{64}', expected_sha256) or digest != expected_sha256:
        raise ValueError('SOURCE_IDENTITY_NOT_PINNED')
    manifest = json.loads(raw)
    root = Path(__file__).resolve().parent
    expected = {'bounded_reference_mcp.py', 'reference_mcp.py', 'role_fixtures.py', 'role-fixtures.json'}
    if (set(manifest) != {'schemaVersion', 'mode', 'files', 'dependencies'}
            or manifest['schemaVersion'] != 'finance.synthetic-mcp-source.v1'
            or manifest['mode'] != 'STATELESS_BOUNDED'
            or set(manifest['files']) != expected
            or set(manifest['dependencies']) != {'mcp', 'fastmcp', 'anyio', 'starlette', 'uvicorn'}):
        raise ValueError('SOURCE_IDENTITY_INVALID')
    for name, file_digest in manifest['files'].items():
        if hashlib.sha256((root/name).read_bytes()).hexdigest() != file_digest:
            raise ValueError('SOURCE_BYTES_CHANGED')
    for package, pin in manifest['dependencies'].items():
        distribution = importlib.metadata.distribution(package)
        if set(pin) != {'version', 'pythonFilesSha256'} or distribution.version != pin['version']:
            raise ValueError('SOURCE_DEPENDENCY_CHANGED')
        files = {str(p): hashlib.sha256(distribution.locate_file(p).read_bytes()).hexdigest()
                 for p in distribution.files if str(p).endswith('.py')}
        if files != pin['pythonFilesSha256']:
            raise ValueError('SOURCE_DEPENDENCY_CHANGED')
    return digest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--identity', type=Path, required=True)
    parser.add_argument('--identity-sha256', required=True)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        raise ValueError('SOURCE_PORT_INVALID')
    digest = verify_identity(args.identity, args.identity_sha256)
    from .reference_mcp import mcp
    import uvicorn
    source = mcp.http_app(path='/mcp', stateless_http=True, json_response=True)
    print(json.dumps({'sourceIdentitySha256': digest, 'mode': 'STATELESS_BOUNDED'}), flush=True)
    uvicorn.run(BoundedMcpApp(source), host='127.0.0.1', port=args.port,
                access_log=False, timeout_keep_alive=2, limit_concurrency=16,
                timeout_graceful_shutdown=3)


if __name__ == '__main__':
    main()
