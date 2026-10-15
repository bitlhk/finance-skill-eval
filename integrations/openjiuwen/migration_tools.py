"""Domain tools for the migration agents.

These are the only tools this project adds. Everything else (read / write / edit
/ grep / glob / list) comes from the harness -- and, deliberately, no shell.

Tools are the allowlist: an agent can only act through what it is handed here.
"""
from __future__ import annotations

import asyncio
from functools import partial
import json
import os
import re
import shutil
import tempfile
import sys
from fnmatch import fnmatch
from pathlib import Path
from typing import Any, Callable

from openjiuwen.core.foundation.tool import LocalFunction, ToolCard
try:
    from .command_runtime import execute_command
except ImportError:
    from command_runtime import execute_command

REPO_ROOT = Path(__file__).resolve().parents[2]

# Same allowlist idea as the TS LocalWorker: the program is chosen by the server,
# never by the model.
_ALLOWED_COMPILERS = {
    "java": ("javac", ["--release", "17", "-encoding", "UTF-8", "-J-Duser.language=en", "-J-Dfile.encoding=UTF-8"]),
    "python": ("python", ["-m", "py_compile"]),
    "node": ("node", ["--check"]),
}


def _card(name: str, description: str, params: dict[str, Any]) -> ToolCard:
    return ToolCard(id=f"migration-{name}", name=name, description=description, input_params=params, idempotent=True)


def _tool(name: str, description: str, params: dict[str, Any], fn: Callable[..., Any]) -> LocalFunction:
    return LocalFunction(_card(name, description, params), fn)


# --------------------------------------------------------------------------
# A2: run_scanner
# --------------------------------------------------------------------------

async def _scan(workspace: Path) -> dict[str, Any]:
    """Run the repo-owned static scanner over the workspace. Never executes uploads."""
    project = REPO_ROOT / "scripts"
    script = project / "scan-migration.py"
    if not script.is_file():
        return {"status": "unavailable", "error": "STATIC_SCANNER_MISSING"}

    files: dict[str, str] = {}
    for path in sorted(workspace.rglob("*")):
        if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(workspace.resolve()):
            continue
        rel = path.relative_to(workspace).as_posix()
        if rel.startswith((".", "AGENT.md", "SOUL.md", "IDENTITY.md", "USER.md", "HEARTBEAT.md")):
            continue
        if rel.split("/")[0] in {"agents", "coding_memory", "context", "memory", "messages", "skills", "todo"}:
            continue
        try:
            if path.stat().st_size > 512_000:
                continue
            files[rel] = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue

    if not files:
        return {"status": "unavailable", "error": "NO_READABLE_FILES"}

    env = {**os.environ, "PYTHONUTF8": "1"}
    proc = await asyncio.create_subprocess_exec(
        "uv", "run", "--project", str(project), "--locked", "python", "-I", str(script),
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(json.dumps({"files": files}).encode()), 120)
    except TimeoutError:
        proc.kill()
        return {"status": "unavailable", "error": "STATIC_SCAN_TIMEOUT"}
    if proc.returncode != 0:
        return {"status": "unavailable", "error": f"STATIC_SCAN_FAILED: {err.decode(errors='replace')[:300]}"}
    try:
        parsed = json.loads(out)
    except ValueError:
        return {"status": "unavailable", "error": "STATIC_SCAN_INVALID_OUTPUT"}

    # Coverage is the reason this tool exists: it is what the agent cannot produce
    # about itself -- the files it never looked at.
    parsed["status"] = "ok"
    parsed["scannedFileCount"] = len(files)
    return parsed


def build_run_scanner(workspace: Path, capture: list[dict[str, Any]] | None = None) -> LocalFunction:
    async def run_scanner(**_kwargs: Any) -> dict[str, Any]:
        result = await _scan(workspace)
        if capture is not None and isinstance(result, dict):
            capture.append(result)
        return result

    return _tool(
        "run_scanner",
        "Run the repository static scanner over the workspace. Returns deterministic findings, "
        "per-file coverage, and `structure`: the package's directories and what each file is for. "
        "Read-only; never executes uploaded code.",
        {"type": "object", "properties": {}, "additionalProperties": False},
        run_scanner,
    )


# --------------------------------------------------------------------------
# A4: compile and contract test
# --------------------------------------------------------------------------

async def _run_process(workspace: Path, argv: list[str], timeout: float, env: dict[str, str] | None = None) -> dict[str, Any]:
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv, cwd=str(workspace),
            stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env=env or {**os.environ, "PYTHONUTF8": "1"},
        )
    except OSError as exc:
        # A command that cannot be executed at all -- the toolchain is missing -- arrives as an
        # exception, not an exit code. `service-launch.ts` reports the same case the same way; an
        # exception here would leave the agent with a tool error instead of something to act on.
        return {"exitCode": None, "stdout": "", "stderr": f"PROGRAM_NOT_RUNNABLE: {argv[0]}: {exc}",
                "timedOut": False}
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except TimeoutError:
        proc.kill()
        return {"exitCode": None, "stdout": "", "stderr": "timeout", "timedOut": True}
    limit = 64 * 1024
    return {
        "exitCode": proc.returncode,
        "stdout": out[:limit].decode(errors="replace"),
        "stderr": err[:limit].decode(errors="replace"),
        "timedOut": False,
    }


def build_compile_tool(workspace: Path, capture: list[dict[str, Any]] | None = None) -> LocalFunction:
    async def compile_source(language: str = "python", paths: list[str] | None = None) -> dict[str, Any]:
        result = await _compile_source(workspace, language, paths)
        if capture is not None and isinstance(result, dict):
            capture.append({"tool": "compile_source", "language": language,
                            "files": result.get("files", []),
                            "passed": result.get("passed"), "detail": result.get("error") or result.get("stderr", "")[:600]})
        return result

    return _tool(
        "compile_source",
        "Compile the current workspace sources with the server-approved toolchain for the given "
        "language (java | python | node). `paths` accepts source files only, never a directory or "
        "build descriptor such as pom.xml; omit it to discover all source files. Java is the "
        "current pure-JDK-17 delivery path and third-party classpaths are not available. Returns "
        "the exit code and compiler output.",
        {
            "type": "object",
            "properties": {
                "language": {"type": "string", "enum": ["java", "python", "node"]},
                "paths": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["language"],
            "additionalProperties": False,
        },
        compile_source,
    )


async def _compile_source(workspace: Path, language: str, paths: list[str] | None) -> dict[str, Any]:
    spec = _ALLOWED_COMPILERS.get(str(language).lower())
    if spec is None:
        return {"passed": False, "error": f"UNSUPPORTED_LANGUAGE: {language}"}
    program, prefix = spec
    if program not in {"javac", "python", "node"}:
        return {"passed": False, "error": "PROGRAM_NOT_ALLOWED"}
    targets = [p for p in (paths or []) if p]
    allowed_suffixes = {
        "java": (".java",), "python": (".py",), "node": (".js", ".mjs", ".cjs"),
    }[str(language).lower()]
    invalid = [target for target in targets if not target.lower().endswith(allowed_suffixes)]
    if invalid:
        return {"passed": False, "error": "INVALID_SOURCE_PATHS: paths must name source files only; "
                f"omit paths for automatic discovery. Invalid: {', '.join(invalid)}"}
    if not targets:
        suffix = {"java": ".java", "python": ".py", "node": ".js"}[str(language).lower()]
        targets = [p.relative_to(workspace).as_posix()
                   for p in sorted(workspace.rglob(f"*{suffix}"))
                   if "memory" not in p.parts and "agents" not in p.parts]
    if not targets:
        return {"passed": False, "error": "NO_SOURCE_FILES"}
    result = await _run_process(workspace, [program, *prefix, *targets], 120)
    return {
        "passed": result["exitCode"] == 0,
        "language": language,
        "files": targets,
        "stderr": result["stderr"][:4000],
        "timedOut": result["timedOut"],
    }


def _shape_ok(value: Any, schema: Any) -> tuple[bool, str]:
    """Minimal JSON-Schema shape check. Deliberately shallow: this asserts the
    interface did not change, not that the business values are right."""
    if not isinstance(schema, dict) or not schema:
        return True, ""
    declared = schema.get("type")
    if isinstance(declared, list):
        types = [str(t) for t in declared]
    elif declared:
        types = [str(declared)]
    else:
        types = []
    mapping = {
        "object": lambda v: isinstance(v, dict),
        "array": lambda v: isinstance(v, list),
        "string": lambda v: isinstance(v, str),
        "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
        "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
        "boolean": lambda v: isinstance(v, bool),
        "null": lambda v: v is None,
    }
    if types and not any(mapping[t](value) for t in types if t in mapping):
        return False, f"expected {types}, got {type(value).__name__}"
    for name in schema.get("required", []) or []:
        if not isinstance(value, dict) or name not in value:
            return False, f"missing required property: {name}"
    return True, ""


_PEP723 = re.compile(r"^#\s*///\s*script\s*$", re.MULTILINE)
_LAUNCH_TIMEOUT = 180.0


def _relative(workspace: Path, path: Path) -> str:
    return path.relative_to(workspace).as_posix()


def _python_argv(workspace: Path, entry: Path, *, isolated: bool) -> list[str]:
    """Launch in the Skill package's own environment -- never the agent's interpreter.

    Mirrors `pythonCommand` in src/service/technical-validation.ts. `sys.executable` is the
    platform's environment; testing the deliverable in it would validate an environment the
    deliverable will never run in.

    Two things about this are easy to get wrong, and both were verified against uv directly:

    * uv only reads a PEP 723 block when the script is uv's *own* argument. Through the
      `python` subcommand it builds an empty environment, so a script that declares a
      dependency silently runs without it.
    * `-I` also implies `-P`, which keeps the script's own directory off `sys.path`. A Script
      is a standalone program so that is right for it, but a service is a project whose entry
      imports sibling modules, so it launches without `-I`.
    """
    directory = entry.parent
    while True:
        if (directory / "pyproject.toml").is_file():
            args = ["run", "--project", _relative(workspace, directory)]
            if (directory / "uv.lock").is_file():
                args.append("--locked")
            guard = ["-I"] if isolated else []
            return ["uv", *args, "python", *guard, _relative(workspace, entry)]
        if directory == workspace:
            break
        directory = directory.parent
    relative = _relative(workspace, entry)
    if _PEP723.search(entry.read_text(encoding="utf-8", errors="replace")):
        return ["uv", "run", "--no-project", relative]
    guard = ["-I"] if isolated else []
    return ["uv", "run", "--no-project", "python", *guard, relative]


async def _node_argv(workspace: Path, entry: Path) -> tuple[list[str] | None, str]:
    """Node has no PEP 723 equivalent, so the package's `package.json` is installed first."""
    directory = entry.parent
    while True:
        if (directory / "package.json").is_file():
            if not (directory / "node_modules").is_dir():
                result = await _run_process(workspace, ["npm", "install", "--omit=dev", "--no-audit", "--no-fund"],
                                            _LAUNCH_TIMEOUT)
                if result["exitCode"] != 0:
                    return None, f"DEPENDENCY_RESOLUTION_FAILED: {result['stderr'][:600]}"
            return ["node", _relative(workspace, entry)], ""
        if directory == workspace:
            return ["node", _relative(workspace, entry)], ""
        directory = directory.parent


def _parse_rpc_body(body: str) -> Any:
    body = body.strip()
    if not body:
        return None
    if body.startswith(("{", "[")):
        return json.loads(body)
    for line in body.splitlines():
        if line.startswith("data:"):
            return json.loads(line[5:].strip())
    return None


def _mcp_post(url: str, payload: dict[str, Any], session_id: str | None = None, timeout: float = 30.0,
              request_headers: dict[str, str] | None = None) -> tuple[str | None, Any]:
    import urllib.request

    headers = {"content-type": "application/json", "accept": "application/json, text/event-stream"}
    headers.update(request_headers or {})
    if session_id:
        headers["mcp-session-id"] = session_id
    request = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.headers.get("mcp-session-id") or session_id, _parse_rpc_body(response.read().decode("utf-8", "replace"))


def _free_port() -> int:
    import socket

    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


async def _terminate(proc: Any) -> None:
    """Stop a service and everything it spawned.

    Killing `uv` alone is not enough: the interpreter it launched inherits the pipes and keeps
    running, so `wait()` would block on a process that is waiting for its own child.
    """
    if proc.returncode is not None:
        return
    try:
        if os.name == "nt":
            await asyncio.create_subprocess_exec(
                "taskkill", "/PID", str(proc.pid), "/T", "/F",
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        else:
            proc.kill()
    except OSError:
        proc.kill()
    try:
        await asyncio.wait_for(proc.wait(), 20)
    except (TimeoutError, ProcessLookupError):
        pass


async def _wait_for_port(port: int, timeout: float) -> bool:
    import socket

    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), 0.5):
                return True
        except OSError:
            await asyncio.sleep(0.4)
    return False


def _is_implicit_script_context(dependency: dict[str, Any]) -> bool:
    """Return whether a Runtime dependency is already supplied by the Script process itself."""
    binding = dependency.get("binding") or {}
    return (
        dependency.get("owner") == "RUNTIME"
        and dependency.get("action") == "INJECT"
        and dependency.get("sensitive") is not True
        and binding.get("kind") == "SCRIPT_CONTEXT"
        and str(binding.get("name") or "").strip().lower() in {"workspace", "cwd"}
    )


def _unsupported_script_injections(dependencies: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        dependency for dependency in dependencies
        if dependency.get("owner") == "RUNTIME"
        and dependency.get("action") == "INJECT"
        and not _is_implicit_script_context(dependency)
    ]


async def _script_contract(workspace: Path, entry: dict[str, Any], source: Path, sample: Any) -> dict[str, Any]:
    kind = str(entry.get("language", "python")).lower()
    if kind == "python":
        argv = _python_argv(workspace, source, isolated=True)
    elif kind == "node":
        argv, error = await _node_argv(workspace, source)
        if argv is None:
            return {"passed": False, "error": error}
    else:
        return {"passed": False, "error": f"CONTRACT_TEST_UNSUPPORTED_LANGUAGE: {kind}"}

    absolute_argv = [argv[0]]
    for index, argument in enumerate(argv[1:], 1):
        candidate = (workspace / argument).resolve()
        if argument == source.relative_to(workspace).as_posix() or argv[index-1] == '--project' or (candidate.exists() and workspace.resolve() in candidate.parents):
            argument = str(candidate)
        absolute_argv.append(argument)
    with tempfile.TemporaryDirectory(prefix='migration-contract-workspace-') as execution_workspace:
        # Explicit fixture data is copied into the same isolated cwd shape used by Runtime.
        # Other Skill files stay in the package directory and are never mistaken for run data.
        fixture_directory = workspace / 'workspace'
        if any(_is_implicit_script_context(item) for item in entry.get('dependencies', [])) and fixture_directory.is_dir():
            shutil.copytree(fixture_directory, execution_workspace, dirs_exist_ok=True)
        try:
            result = await execute_command(execution_workspace, absolute_argv, json.dumps(sample), timeout=_LAUNCH_TIMEOUT)
        except TimeoutError:
            return {"passed": False, "error": "CONTRACT_TEST_TIMEOUT"}
        if result['exitCode'] != 0:
            return {"passed": False, "error": f"EXIT_{result['exitCode']}", "stderr": result['stderr'][:1500]}
        out = result['stdout'].encode('utf-8')
    try:
        produced = json.loads(out.decode(errors="replace").strip() or "null")
    except ValueError:
        return {"passed": False, "error": "OUTPUT_NOT_JSON"}
    return {"passed": True, "produced": produced}


async def _mcp_contract(workspace: Path, entry: dict[str, Any], sample: Any, execute_call: bool = True) -> dict[str, Any]:
    """An MCP Tool's interface is not a program's stdin; it is what the service advertises and
    returns over the protocol. So start the service and speak MCP to it.

    The service is the agent's, so how to start it is the agent's answer: `start` (and an optional
    one-shot `prepare`). The platform only picks a free port and exports `PORT`.

    The gate is: it starts, it advertises the Tool, it answers. Whether the interface drifted from
    the baseline is **reported**, not gated -- migration adapts on purpose (removing runtime
    coupling changes how a Tool is called), so an exact match is neither achievable nor required.
    """
    start = [str(part) for part in (entry.get("start") or []) if str(part)]
    if not start:
        return {"passed": False, "error": "NO_START_COMMAND: 交付物没有声明启动命令，平台不知道该怎么起它"}
    port = _free_port()
    env = {**os.environ, "PYTHONUTF8": "1", "PORT": str(port)}

    prepare = [str(part) for part in (entry.get("prepare") or []) if str(part)]
    if prepare:
        step = await _run_process(workspace, prepare, _LAUNCH_TIMEOUT, env=env)
        if step["exitCode"] != 0:
            return {"passed": False, "error": "PREPARE_FAILED", "stderr": (step["stderr"] or "")[:1200]}

    try:
        proc = await asyncio.create_subprocess_exec(
            *start, cwd=str(workspace),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=env,
        )
    except OSError as exc:
        return {"passed": False, "error": f"SERVICE_FAILED_TO_START: 启动命令 {' '.join(start)} 无法执行：{exc}"}
    execution_workspace = tempfile.TemporaryDirectory(prefix="migration-mcp-workspace-")
    try:
        # Preserve fixture-relative paths while keeping the request cwd separate from the package.
        fixture_directory = workspace / "workspace"
        if fixture_directory.is_dir():
            shutil.copytree(fixture_directory, Path(execution_workspace.name) / "workspace", dirs_exist_ok=True)
        post = partial(_mcp_post, request_headers={"X-Workspace-Root": str(Path(execution_workspace.name).resolve())})
        if not await _wait_for_port(port, _LAUNCH_TIMEOUT):
            await _terminate(proc)
            return {"passed": False, "error": "SERVICE_DID_NOT_START",
                    "stderr": f"启动命令 {' '.join(start)} 在 {int(_LAUNCH_TIMEOUT)}s 内没有监听 PORT={port}"}
        url = f"http://127.0.0.1:{port}/mcp"
        session, _ = await asyncio.to_thread(post, url, {
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                       "clientInfo": {"name": "finance-skill-migration", "version": "0.1.0"}}})
        await asyncio.to_thread(post, url, {"jsonrpc": "2.0", "method": "notifications/initialized"}, session)
        _, listed = await asyncio.to_thread(post, url, {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}, session)
        tools = ((listed or {}).get("result") or {}).get("tools") or []
        name = str(entry.get("toolName") or "")
        observed = next((tool for tool in tools if tool.get("name") == name), None)
        if observed is None:
            return {"passed": False, "advertisedTools": [tool.get("name") for tool in tools],
                    "error": f"TOOL_NOT_ADVERTISED: {name}"}
        drift = []
        if observed.get("inputSchema") != entry.get("inputSchema"):
            drift.append({"where": "inputSchema", "baseline": entry.get("inputSchema"), "observed": observed.get("inputSchema")})
        if not execute_call:
            return {"passed": True, "callExecuted": False, "drift": drift,
                    "note": "服务启动与工具发现通过；实际业务调用待测试 Runtime 提供依赖后验证。"}
        _, called = await asyncio.to_thread(post, url, {
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": {"name": name, "arguments": sample}}, session)
        result = ((called or {}).get("result") or {})
        texts = [item.get("text", "") for item in (result.get("content") or []) if item.get("type") == "text"]
        if result.get("isError"):
            return {"passed": False, "error": f"TOOL_CALL_FAILED: {''.join(texts)[:600]}"}
        try:
            produced = json.loads(texts[0] if texts else "null")
        except ValueError:
            return {"passed": False, "error": "OUTPUT_NOT_JSON", "drift": drift}
        # The baseline's output shape is what the call must still resemble; a mismatch is drift
        # too, and still a report rather than a stop.
        ok, detail = _shape_ok(produced, entry.get("outputSchema"))
        if not ok:
            drift.append({"where": "outputShape", "baseline": entry.get("outputSchema"), "observed": detail})
        return {"passed": True, "produced": produced, "drift": drift}
    except Exception as error:  # noqa: BLE001 - the reason is the result
        return {"passed": False, "error": f"MCP_CONTRACT_FAILED: {type(error).__name__}: {error}"}
    finally:
        await _terminate(proc)
        execution_workspace.cleanup()


async def _mcp_contract_suite(workspace: Path, cases: list[dict[str, Any]], start: list[str],
                              prepare: list[str] | None = None) -> dict[str, Any]:
    """Build and start one shared MCP service once, then validate every requested Tool."""
    if not start:
        return {"passed": False, "error": "NO_START_COMMAND", "results": []}
    port = _free_port()
    env = {**os.environ, "PYTHONUTF8": "1", "PORT": str(port)}
    if prepare:
        step = await _run_process(workspace, [str(part) for part in prepare], _LAUNCH_TIMEOUT, env=env)
        if step["exitCode"] != 0:
            return {"passed": False, "error": "PREPARE_FAILED", "stderr": (step["stderr"] or "")[:1200],
                    "results": []}
    try:
        proc = await asyncio.create_subprocess_exec(
            *[str(part) for part in start], cwd=str(workspace), stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, env=env)
    except OSError as exc:
        return {"passed": False, "error": f"SERVICE_FAILED_TO_START: {exc}", "results": []}
    execution_workspace = tempfile.TemporaryDirectory(prefix="migration-mcp-workspace-")
    try:
        # Preserve fixture-relative paths while keeping the request cwd separate from the package.
        fixture_directory = workspace / "workspace"
        if fixture_directory.is_dir():
            shutil.copytree(fixture_directory, Path(execution_workspace.name) / "workspace", dirs_exist_ok=True)
        post = partial(_mcp_post, request_headers={"X-Workspace-Root": str(Path(execution_workspace.name).resolve())})
        if not await _wait_for_port(port, _LAUNCH_TIMEOUT):
            return {"passed": False, "error": "SERVICE_DID_NOT_START", "results": []}
        url = f"http://127.0.0.1:{port}/mcp"
        session, _ = await asyncio.to_thread(post, url, {
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                       "clientInfo": {"name": "finance-skill-migration", "version": "0.1.0"}}})
        await asyncio.to_thread(post, url, {"jsonrpc": "2.0", "method": "notifications/initialized"}, session)
        _, listed = await asyncio.to_thread(post, url, {
            "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}, session)
        advertised = ((listed or {}).get("result") or {}).get("tools") or []
        results = []
        for index, case in enumerate(cases, 3):
            entry, sample = case["entry"], case["sample"]
            observed = next((tool for tool in advertised if tool.get("name") == entry.get("toolName")), None)
            if observed is None:
                results.append({"passed": False, "toolId": case["toolId"],
                                "error": f"TOOL_NOT_ADVERTISED: {entry.get('toolName')}"})
                continue
            drift = []
            if observed.get("inputSchema") != entry.get("inputSchema"):
                drift.append({"where": "inputSchema", "baseline": entry.get("inputSchema"),
                              "observed": observed.get("inputSchema")})
            if not case["executeCall"]:
                results.append({"passed": True, "toolId": case["toolId"], "inputShapeOk": True,
                                "contractPassed": True, "callExecuted": False,
                                "runtimeDependenciesPending": case["runtimePending"], "drift": drift, "error": ""})
                continue
            _, called = await asyncio.to_thread(post, url, {
                "jsonrpc": "2.0", "id": index, "method": "tools/call",
                "params": {"name": entry.get("toolName"), "arguments": sample}}, session)
            result = ((called or {}).get("result") or {})
            texts = [item.get("text", "") for item in (result.get("content") or []) if item.get("type") == "text"]
            if result.get("isError"):
                results.append({"passed": False, "toolId": case["toolId"],
                                "error": f"TOOL_CALL_FAILED: {''.join(texts)[:600]}"})
                continue
            try:
                produced = json.loads(texts[0] if texts else "null")
            except ValueError:
                results.append({"passed": False, "toolId": case["toolId"], "error": "OUTPUT_NOT_JSON"})
                continue
            ok, detail = _shape_ok(produced, entry.get("outputSchema"))
            if not ok:
                drift.append({"where": "outputShape", "baseline": entry.get("outputSchema"), "observed": detail})
            results.append({"passed": True, "toolId": case["toolId"], "inputShapeOk": True,
                            "contractPassed": True, "callExecuted": True,
                            "runtimeDependenciesPending": [], "drift": drift, "error": ""})
        return {"passed": bool(results) and all(item.get("passed") for item in results), "results": results}
    except Exception as error:  # noqa: BLE001
        return {"passed": False, "error": f"MCP_CONTRACT_FAILED: {type(error).__name__}: {error}", "results": []}
    finally:
        await _terminate(proc)
        execution_workspace.cleanup()


async def _contract_suite(workspace: Path, contract: dict[str, Any], tool_ids: list[str],
                          start: list[str], prepare: list[str] | None = None) -> dict[str, Any]:
    cases = []
    for tool_id in tool_ids:
        entry = contract.get(tool_id)
        if not entry:
            return {"passed": False, "error": f"UNKNOWN_TOOL_CONTRACT: {tool_id}", "results": []}
        if str(entry.get("form", "")).upper() != "MCP":
            return {"passed": False, "error": f"NOT_MCP_TOOL: {tool_id}", "results": []}
        sample_missing = bool(entry.get("sampleMissing")) and "sampleInput" not in entry
        sample = entry.get("sampleInput") or {}
        shape_ok, detail = _shape_ok(sample, entry.get("inputSchema"))
        if not shape_ok and not sample_missing:
            return {"passed": False, "error": f"SAMPLE_INPUT_SHAPE: {tool_id}: {detail}", "results": []}
        runtime_pending = [d.get("name") or d.get("key") for d in entry.get("dependencies", [])
                           if d.get("owner") == "RUNTIME" and d.get("action") == "INJECT"]
        cases.append({"toolId": tool_id, "entry": entry, "sample": sample,
                      "executeCall": not runtime_pending and not sample_missing,
                      "runtimePending": runtime_pending})
    return await _mcp_contract_suite(workspace, cases, start, prepare)


def build_contract_suite_tool(workspace: Path, contract: dict[str, Any],
                              capture: list[dict[str, Any]] | None = None) -> LocalFunction:
    async def run_mcp_contract_suite(tool_ids: list[str], start: list[str],
                                     prepare: list[str] | None = None) -> dict[str, Any]:
        result = await _contract_suite(workspace, contract, tool_ids, start, prepare)
        if capture is not None:
            capture.append({"tool": "run_mcp_contract_suite", "toolIds": tool_ids,
                            "passed": result.get("passed"), "results": result.get("results", []),
                            **({"error": result.get("error")} if result.get("error") else {})})
        return result

    return _tool(
        "run_mcp_contract_suite",
        "Build and start one shared MCP service once, then validate tools/list and each requested "
        "Tool contract. Prefer this over repeated run_contract_test calls when multiple Tools share "
        "the same start command.",
        {"type": "object", "properties": {
            "tool_ids": {"type": "array", "items": {"type": "string"}, "minItems": 1},
            "start": {"type": "array", "items": {"type": "string"}, "minItems": 1},
            "prepare": {"type": "array", "items": {"type": "string"}},
        }, "required": ["tool_ids", "start"], "additionalProperties": False},
        run_mcp_contract_suite,
    )


def build_contract_test_tool(workspace: Path, contract: dict[str, Any],
                             capture: list[dict[str, Any]] | None = None) -> LocalFunction:
    """`contract` maps toolId -> {form, language, toolName, inputSchema, outputSchema, sampleInput}.
    The Schema and the sample come from the analysis of the source, not from this session.

    `start` / `prepare` are **not** in the contract: how to run the deliverable is the agent's own
    answer, and it arrives as an argument to this call. The contract the platform sends carries only
    what the analysis read out of the source, so a test that waited for `start` there could never
    run -- and an MCP Tool that cannot be tested is not a fact about the migration."""

    async def run_contract_test(tool_id: str, entrypoint: str = "", start: list[str] | None = None,
                                prepare: list[str] | None = None) -> dict[str, Any]:
        result = await _contract_test(workspace, contract, tool_id, entrypoint, start, prepare)
        if capture is not None and isinstance(result, dict):
            capture.append({"tool": "run_contract_test", "toolId": tool_id,
                            **{k: v for k, v in result.items() if k != "drift"}})
        return result

    return _tool(
        "run_contract_test",
        "Run the interface contract test for one migrated tool. The gate is only that it works: for "
        "SCRIPT the entrypoint runs with the sample on stdin; for MCP the service starts and answers "
        "tools/list and tools/call. Worth preserving is the baseline the analysis read out of the "
        "source; how far the interface drifted from it is REPORTED in `drift`, not passed or failed "
        "-- migration adapts on purpose. It never judges whether the business values are right. "
        "Either way the code runs in the Skill package's own declared environment, not the agent's.",
        {
            "type": "object",
            "properties": {
                "tool_id": {"type": "string"},
                "entrypoint": {"type": "string",
                               "description": "Workspace-relative SCRIPT entry. For MCP use start instead."},
                # How to start the service is the agent's own answer, and this test is the only
                # place it can be given: the platform has no way to work it out, and the contract it
                # sends carries only what the analysis read out of the source. Without it an MCP
                # Tool cannot be tested at all -- which is not a fact about the migration.
                "start": {"type": "array", "items": {"type": "string"},
                          "description": "argv array that starts the MCP service, e.g. [\"uv\",\"run\",\"--no-project\",\"server.py\"]. Required for MCP."},
                "prepare": {"type": "array", "items": {"type": "string"},
                            "description": "Optional one-shot argv to run first (install, build). Must exit 0."},
            },
            "required": ["tool_id"],
            "additionalProperties": False,
        },
        run_contract_test,
    )


async def _contract_test(workspace: Path, contract: dict[str, Any], tool_id: str,
                         entrypoint: str, start: list[str] | None = None,
                         prepare: list[str] | None = None) -> dict[str, Any]:
    entry = contract.get(tool_id)
    if not entry:
        return {"passed": False, "error": f"UNKNOWN_TOOL_CONTRACT: {tool_id}"}
    if start or prepare:
        entry = {**entry,
                 **({"start": start} if start else {}),
                 **({"prepare": prepare} if prepare else {})}

    form = str(entry.get("form", "SCRIPT")).upper()
    dependencies=entry.get('dependencies', [])
    if form=='SCRIPT':
        source=(workspace / str(entrypoint or '')).resolve()
        if workspace.resolve() not in source.parents or not source.is_file():
            return {"passed":False,"toolId":tool_id,"error":f"ENTRYPOINT_MISSING: {entrypoint}"}
        if _unsupported_script_injections(dependencies):
            return {"passed":False,"toolId":tool_id,"error":"SCRIPT_RUNTIME_INJECTION_UNSUPPORTED: 需要运行依赖时请使用 MCP"}
    sample_missing=bool(entry.get('sampleMissing')) and 'sampleInput' not in entry
    if sample_missing and form=='SCRIPT':
        return {"passed":True,"toolId":tool_id,"callExecuted":False,"note":f"NO_SAMPLE: {entry['sampleMissing']}"}
    sample = entry.get("sampleInput") or {}
    ok, detail = _shape_ok(sample, entry.get("inputSchema"))
    if not ok and not sample_missing:
        return {"passed": False, "toolId": tool_id, "inputShapeOk": False, "error": f"SAMPLE_INPUT_SHAPE: {detail}"}

    form = str(entry.get("form", "SCRIPT")).upper()
    # `blocking` answers whether a missing contract prevents migration. It does not mean an actual
    # invocation can run without the dependency value. A4 receives declarations, never credentials
    # or tenant data, so every Runtime injection remains pending until technical validation.
    runtime_pending = [d.get("name") or d.get("key") for d in entry.get("dependencies", [])
                       if d.get("owner") == "RUNTIME" and d.get("action") == "INJECT"
                       and not (form == "SCRIPT" and _is_implicit_script_context(d))]
    if form == "MCP":
        outcome = await _mcp_contract(workspace, entry, sample, execute_call=not runtime_pending and not sample_missing)
    else:
        chosen = str(entrypoint or "")
        source = (workspace / chosen).resolve()
        if workspace.resolve() not in source.parents or not source.is_file():
            return {"passed": False, "toolId": tool_id, "error": f"ENTRYPOINT_MISSING: {chosen}"}
        if _unsupported_script_injections(entry.get('dependencies', [])):
            return {"passed":False,"toolId":tool_id,"error":"SCRIPT_RUNTIME_INJECTION_UNSUPPORTED: 需要运行依赖时请使用 MCP"}
        outcome = await _script_contract(workspace, entry, source, sample)
    if not outcome.get("passed"):
        return {"passed": False, "toolId": tool_id, **{k: v for k, v in outcome.items() if k != "passed"}}
    # Drift from the baseline is reported, never a stop: migration adapts on purpose. The
    # reasons for what changed come from the agent's own delivery notes.
    drift = outcome.get("drift") or []
    if form != "MCP" and outcome.get("callExecuted", True):
        shape_ok, shape_detail = _shape_ok(outcome.get("produced"), entry.get("outputSchema"))
        if not shape_ok:
            drift.append({"where": "outputShape", "baseline": entry.get("outputSchema"), "observed": shape_detail})
    return {
        "passed": True,
        "toolId": tool_id,
        "inputShapeOk": True,
        "contractPassed": True,
        "callExecuted": outcome.get("callExecuted", True),
        "runtimeDependenciesPending": runtime_pending,
        "drift": drift,
        "error": "",
    }


# --------------------------------------------------------------------------
# grep: read the files ourselves, because the harness's one shells out
# --------------------------------------------------------------------------

_MAX_FILE_BYTES = 512_000      # the same ceiling the scanner uses for one file
_MAX_COLUMNS = 500
_SKIP_DIRS = frozenset({".git", ".svn", ".hg", ".bzr", ".jj", ".sl", "__pycache__",
                        "node_modules", ".venv", ".mypy_cache", ".pytest_cache"})
# Deliberately small. The harness's own `type` filter needs ripgrep, which this platform does not have.
_TYPE_SUFFIXES = {
    "py": (".py",), "js": (".js", ".mjs", ".cjs"), "ts": (".ts", ".tsx"),
    "java": (".java",), "md": (".md", ".mdx"), "json": (".json",),
    "yaml": (".yaml", ".yml"), "sh": (".sh", ".bash"),
}


def _readable_files(root: Path, workspace: Path):
    """Every text file under `root`, in path order, skipping what grep itself would skip."""
    for path in ([root] if root.is_file() else sorted(root.rglob("*"))):
        if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(workspace.resolve()):
            continue
        if _SKIP_DIRS.intersection(path.relative_to(workspace).parts):
            continue
        try:
            if path.stat().st_size > _MAX_FILE_BYTES:
                continue
            yield path, path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            # Binary or unreadable: grep would call it binary and move on.
            continue


def _hits(pattern, text: str, *, mode: str, before: int, after: int):
    """Matching line numbers, or -- in content mode -- (line, is_match) pairs including context."""
    lines = text.splitlines()
    matched = [index for index, line in enumerate(lines) if pattern.search(line)]
    if mode != "content":
        return matched
    wanted: dict[int, bool] = {}
    for index in matched:
        wanted[index] = True
        for neighbour in range(max(0, index - before), min(len(lines), index + after + 1)):
            wanted.setdefault(neighbour, False)
    return sorted(wanted.items())


def build_grep_tool(workspace: Path, capture: list[dict[str, Any]] | None = None) -> LocalFunction:
    """Search the workspace by reading it -- no shell, and no way out of the workspace.

    The harness's `GrepTool` builds a command line and hands it to `SysOperation.shell()`. On Windows
    without ripgrep that command is a PowerShell *pipeline script*, and the shell's allowlist gate
    reads the command's first token -- so it sees the script's opening statement and refuses every
    call. Installing rg would paper over it, and the shell would still be inside an agent whose whole
    point is that it has none.

    The inputs and the output shape match the tool it replaces, so the agent's habits still hold.
    """
    root = workspace.resolve()

    async def grep(pattern: str = "", path: str = "", output_mode: str = "content", **options: Any) -> dict[str, Any]:
        if not pattern:
            return {"error": "pattern is required"}
        mode = str(output_mode or "content")
        if mode not in {"content", "files_with_matches", "count"}:
            return {"error": "output_mode must be one of: content, files_with_matches, count"}
        if options.get("multiline"):
            return {"error": "multiline search requires ripgrep (rg) to be installed"}

        target = Path(path).resolve() if path else root
        # The boundary is the workspace itself, not a permission list: nothing outside it is searchable.
        if target != root and root not in target.parents:
            return {"error": f"SEARCH_OUTSIDE_WORKSPACE: {path}"}
        if not target.exists():
            return {"error": f"path does not exist: {path}"}

        try:
            flags = re.IGNORECASE if (options.get("-i") or options.get("ignore_case")) else 0
            compiled = re.compile(pattern, flags)
        except re.error as error:
            return {"error": f"invalid pattern: {error}"}

        suffixes = _TYPE_SUFFIXES.get(str(options.get("type") or "").lower())
        globs = [item.strip() for item in str(options.get("glob") or "").split(",") if item.strip()]
        before = int(options.get("-B") or options.get("-C") or options.get("context") or 0)
        after = int(options.get("-A") or options.get("-C") or options.get("context") or 0)
        numbered = options.get("-n", True) is not False

        base = target if target.is_dir() else target.parent
        files = list(_readable_files(target, root))
        lines: list[str] = []
        matched_files = 0
        total = 0

        for file_path, text in files:
            relative = file_path.relative_to(root).as_posix()
            if suffixes and not relative.endswith(suffixes):
                continue
            if globs and not any(fnmatch(relative, item) or fnmatch(file_path.name, item) for item in globs):
                continue
            found = _hits(compiled, text, mode=mode, before=before, after=after)
            if not found:
                continue
            matched_files += 1
            shown = file_path.relative_to(base).as_posix() if target.is_dir() else file_path.name
            if mode == "files_with_matches":
                lines.append(shown)
                continue
            if mode == "count":
                total += len(found)
                lines.append(f"{shown}:{len(found)}")
                continue
            body = text.splitlines()
            for index, is_match in found:
                if is_match:
                    total += 1
                prefix = f"{index + 1}:" if numbered else ""
                lines.append(f"{shown}:{prefix}{body[index][:_MAX_COLUMNS]}")

        offset = int(options.get("offset") or 0)
        limit = options.get("head_limit")
        window = lines[offset:]
        applied = None
        if limit is not None:
            window = window[: int(limit)]
            applied = int(limit)
        content = "\n".join(window)
        data: dict[str, Any] = {
            "stdout": content, "stderr": "", "exit_code": 0 if lines else 1, "mode": mode,
            "appliedOffset": offset or None, "appliedLimit": applied, "content": content,
            "filenames": list(window) if mode == "files_with_matches" else [],
            "numFiles": len(window) if mode == "files_with_matches" else matched_files,
            "count": total,
        }
        if mode == "content":
            data["numLines"] = len(window)
        elif mode == "count":
            data["numMatches"] = total
        if capture is not None:
            capture.append({"tool": "grep", "pattern": pattern[:80], "mode": mode,
                            "files": matched_files, "matches": total})
        return data

    return _tool(
        "grep",
        "Search the workspace with a regular expression. Reads the files directly -- no shell, and the "
        "search cannot leave the workspace. Arguments as usual: `pattern`, `path`, `output_mode` "
        "(content | files_with_matches | count), `-i`, `-n`, `-A`/`-B`/`-C`, `glob`, `head_limit`, "
        "`offset`. Output lines look like `path:line:text`.",
        {
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "Regular expression to search for."},
                "path": {"type": "string", "description": "File or directory to search. Defaults to the workspace."},
                "output_mode": {"type": "string", "enum": ["content", "files_with_matches", "count"]},
                "glob": {"type": "string", "description": "Comma-separated filename patterns to include."},
                "-i": {"type": "boolean", "description": "Case-insensitive."},
                "-n": {"type": "boolean", "description": "Show line numbers (default true)."},
                "-A": {"type": "integer"}, "-B": {"type": "integer"}, "-C": {"type": "integer"},
                "head_limit": {"type": "integer"}, "offset": {"type": "integer"},
            },
            "required": ["pattern"],
            "additionalProperties": True,
        },
        grep,
    )
