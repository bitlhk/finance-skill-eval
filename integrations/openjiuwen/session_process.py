"""Reap a session and its descendants, including Windows child processes."""
import asyncio
import os
import signal


async def terminate_tree(process):
    if os.name == 'nt':
        if process.returncode is None:
            try:
                killer = await asyncio.create_subprocess_exec(
                    'taskkill', '/PID', str(process.pid), '/T', '/F',
                    stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
                await asyncio.wait_for(killer.wait(), 5)
            except (OSError, TimeoutError):
                process.kill()
        await process.wait()
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    if process.returncode is None:
        try:
            await asyncio.wait_for(process.wait(), 3)
        except TimeoutError:
            pass
    # A parent can exit before a descendant that ignores SIGTERM.
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    await process.wait()
