"""Explicitly trusted local execution; this is not an untrusted-code sandbox."""
import asyncio
import os
import signal


async def run_script(command, directory, payload, timeout=45, limit=262144):
    if os.environ.get('FINANCE_EVAL_TRUSTED_LOCAL_SCRIPTS') != '1':
        raise RuntimeError('Local script execution is disabled')
    env = {key: os.environ[key] for key in ('PATH', 'SystemRoot', 'WINDIR', 'LANG', 'LC_ALL') if key in os.environ}
    env.update({key: str(directory) for key in ('HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP')})
    process = await asyncio.create_subprocess_exec(
        *command, cwd=directory, env=env, start_new_session=os.name != 'nt',
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)

    async def read(stream):
        output = bytearray()
        while chunk := await stream.read(8192):
            output.extend(chunk)
            if len(output) > limit:
                raise RuntimeError('Script Tool output exceeds limit')
        return bytes(output)

    async def send():
        try:
            process.stdin.write(payload)
            await process.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            process.stdin.close()

    tasks = [asyncio.create_task(read(process.stdout)), asyncio.create_task(read(process.stderr)), asyncio.create_task(send())]
    try:
        async with asyncio.timeout(timeout):
            stdout, stderr, _ = await asyncio.gather(*tasks)
            await process.wait()
            return process.returncode, stdout, stderr
    finally:
        if os.name == 'nt':
            if process.returncode is None:
                killer = await asyncio.create_subprocess_exec('taskkill', '/pid', str(process.pid), '/T', '/F', stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
                await killer.wait()
        else:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        async def discard(stream):
            while await stream.read(8192):
                pass
        await asyncio.gather(discard(process.stdout), discard(process.stderr))
        await process.wait()
