"""Generic command capability for trusted mounted Skill packages; not an OS sandbox."""
import asyncio
import os
from pathlib import Path
try:
    from .package_runtime import executable, terminate
except ImportError:
    from package_runtime import executable, terminate


def command_environment(environ=None):
    environ = os.environ if environ is None else environ
    # Do not inherit enterprise credentials or Runtime configuration into scripts.
    allowed = {'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA'}
    return {**{key: value for key, value in environ.items() if key.upper() in allowed}, 'PYTHONUTF8': '1', 'PYTHONUNBUFFERED': '1'}


async def execute_command(root, argv, stdin='', environ=None, timeout=30, limit=262144):
    if not isinstance(argv, list) or not argv or len(argv) > 100 or any(not isinstance(arg, str) or '\x00' in arg for arg in argv):
        raise ValueError('Command requires a program argv array')
    if not isinstance(stdin, str) or len(stdin.encode()) > limit:
        raise ValueError('Command stdin exceeds limit')
    root = Path(root).resolve()
    process = await asyncio.create_subprocess_exec(executable(argv[0]), *argv[1:], cwd=root,
        env=command_environment(environ), stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    async def read(stream):
        chunks = bytearray()
        while chunk := await stream.read(4096):
            chunks.extend(chunk)
            if len(chunks) > limit:
                raise ValueError('Command output exceeds limit')
        return chunks.decode('utf-8', errors='replace')
    async def write():
        process.stdin.write(stdin.encode('utf-8'))
        try:
            await process.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            pass
        process.stdin.close()
    tasks = [asyncio.create_task(read(process.stdout)), asyncio.create_task(read(process.stderr)), asyncio.create_task(write()), asyncio.create_task(process.wait())]
    try:
        stdout, stderr, _, code = await asyncio.wait_for(asyncio.gather(*tasks), timeout)
        return {'exitCode': code, 'stdout': stdout, 'stderr': stderr}
    finally:
        await terminate(process)
        for task in tasks:
            if not task.done(): task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
