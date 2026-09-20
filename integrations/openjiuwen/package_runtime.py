"""Candidate-owned launches. Shared by the session's Script and MCP adapters.

New Script bindings carry the very argv used by technical validation; the fallback
exists only for older clients and follows the same package-resolution contract.
"""
import asyncio
import os
from pathlib import Path
import re
import shutil
import socket


def executable(program):
    name = Path(program).name.lower().removesuffix(".exe").removesuffix(".cmd")
    if name not in {"uv", "python", "python3", "node", "npm", "java", "javac", "mvn"}:
        raise ValueError(f"Candidate launch program is not allowed: {program}")
    return shutil.which(program) or program


def script_command(root, target, spec):
    launch = spec.get("launch")
    relative = target.relative_to(root).as_posix()
    if launch:
        args = launch["args"]
        if relative not in args:
            raise ValueError("Script launch does not name its bound entrypoint")
        return [executable(launch["program"]), *args]
    if spec["kind"] == "NODE":
        return [executable("node"), relative]
    directory = target.parent
    while True:
        if (directory / "pyproject.toml").is_file():
            command = [executable("uv"), "run", "--project", directory.relative_to(root).as_posix()]
            if (directory / "uv.lock").is_file():
                command.append("--locked")
            return [*command, "python", "-I", relative]
        if directory == root:
            break
        directory = directory.parent
    if re.search(r"^#\s*///\s*script\s*$", target.read_text(encoding="utf-8"), re.M):
        return [executable("uv"), "run", "--no-project", relative]
    return [executable("uv"), "run", "--no-project", "python", "-I", relative]


def absolute_script_command(root, target, spec):
    """Resolve package-owned launch paths independently of command cwd."""
    command = script_command(root, target, spec)
    result = [command[0]]
    for index, argument in enumerate(command[1:], 1):
        candidate = (root / argument).resolve()
        project = command[index - 1] == '--project'
        if argument == target.relative_to(root).as_posix() or project or (not argument.startswith('-') and candidate.exists() and (candidate == root or root in candidate.parents)):
            if candidate != root and root not in candidate.parents:
                raise ValueError('Script launch path is outside the Skill')
            argument = str(candidate)
        result.append(argument)
    return result


async def terminate(process):
    if process.returncode is not None:
        return
    if os.name == "nt":
        killer = await asyncio.create_subprocess_exec("taskkill", "/PID", str(process.pid), "/T", "/F",
                                                      stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        await killer.wait()
    else:
        # Children stay in the session's process group so supervisor cancellation also reaps them.
        descendants = {process.pid}
        proc_root = Path("/proc")
        if proc_root.is_dir():
            parents = {}
            for item in proc_root.iterdir():
                if item.name.isdigit():
                    try:
                        fields = (item / "stat").read_text().rsplit(")", 1)[1].split()
                        parents[int(item.name)] = int(fields[1])
                    except (OSError, ValueError, IndexError):
                        pass
            while True:
                children = {pid for pid, parent in parents.items() if parent in descendants}
                if children <= descendants:
                    break
                descendants.update(children)
        for pid in reversed(sorted(descendants)):
            try:
                os.kill(pid, 9)
            except ProcessLookupError:
                pass
    await process.wait()


def service_environment(values):
    if not isinstance(values, dict):
        raise ValueError('Service environment must be an object')
    for name, value in values.items():
        if not isinstance(name, str) or not re.fullmatch(r'[A-Z][A-Z0-9_]{0,99}', name) or re.fullmatch(r'PORT|PATH|PATHEXT|HOME|USERPROFILE|SYSTEMROOT|COMSPEC|NODE_OPTIONS|PYTHON.*|LD_.*|DYLD_.*', name) or not isinstance(value, str) or '\x00' in value or len(value.encode()) > 128000:
            raise ValueError('Invalid service environment variable')
    return dict(values)


async def start_candidate_service(root, service):
    """Own a delivered service for exactly one execution; caller registers stop with ExitStack."""
    configuration = service_environment(service.get('environment', {}))
    def protected_error(message):
        return 'Candidate MCP failed; check service configuration and implementation' if configuration else message
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    env = {**os.environ, "PORT": str(port), "PYTHONUTF8": "1", "PYTHONUNBUFFERED": "1"}
    prepare = service.get("prepare") or []
    if prepare:
        process = await asyncio.create_subprocess_exec(executable(prepare[0]), *prepare[1:], cwd=root, env=env,
                                                       stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
        try:
            _, stderr = await asyncio.wait_for(process.communicate(), 120)
            if process.returncode:
                raise RuntimeError(f"Candidate MCP prepare failed: {stderr.decode(errors='replace')[-1200:]}")
        finally:
            await terminate(process)
    env.update(configuration)
    start = service["start"]
    process = await asyncio.create_subprocess_exec(executable(start[0]), *start[1:], cwd=root, env=env,
                                                   stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
    stderr_tail = bytearray()

    async def drain():
        while chunk := await process.stderr.read(4096):
            stderr_tail.extend(chunk)
            del stderr_tail[:-4000]

    draining = asyncio.create_task(drain())

    async def stop():
        await terminate(process)
        await draining

    try:
        async with asyncio.timeout(120):
            while process.returncode is None:
                try:
                    _, writer = await asyncio.open_connection("127.0.0.1", port)
                    writer.close()
                    await writer.wait_closed()
                    return f"http://127.0.0.1:{port}/mcp", stop
                except OSError:
                    await asyncio.sleep(0.2)
        raise RuntimeError(protected_error(f"Candidate MCP exited: {stderr_tail.decode(errors='replace')[-1200:]}"))
    except BaseException:
        await stop()
        raise
