"""Domain tools for the migration agents.

These are the only tools this project adds. Everything else (read / write / edit
/ grep / glob / list) comes from the harness -- and, deliberately, no shell.

Tools are the allowlist: an agent can only act through what it is handed here.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from pathlib import Path
from typing import Any, Callable

from openjiuwen.core.foundation.tool import LocalFunction, ToolCard

REPO_ROOT = Path(__file__).resolve().parents[2]

# Same allowlist idea as the TS LocalWorker: the program is chosen by the server,
# never by the model.
_ALLOWED_COMPILERS = {
    "java": ("javac", ["--release", "17"]),
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
        if not path.is_file():
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
        "Run the repository static scanner over the workspace. Returns deterministic findings "
        "plus per-file coverage. Read-only; never executes uploaded code.",
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
                            "passed": result.get("passed"), "detail": result.get("error") or result.get("stderr", "")[:600]})
        return result

    return _tool(
        "compile_source",
        "Compile the current workspace sources with the server-approved toolchain for the given "
        "language (java | python | node). Returns the exit code and compiler output.",
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


def _mcp_post(url: str, payload: dict[str, Any], session_id: str | None = None, timeout: float = 30.0) -> tuple[str | None, Any]:
    import urllib.request

    headers = {"content-type": "application/json", "accept": "application/json, text/event-stream"}
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

    proc = await asyncio.create_subprocess_exec(
        *argv, cwd=str(workspace),
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        env={**os.environ, "PYTHONUTF8": "1"},
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(json.dumps(sample).encode()), _LAUNCH_TIMEOUT)
    except TimeoutError:
        proc.kill()
        return {"passed": False, "error": "CONTRACT_TEST_TIMEOUT"}
    if proc.returncode != 0:
        return {"passed": False, "error": f"EXIT_{proc.returncode}", "stderr": err.decode(errors="replace")[:1500]}
    try:
        produced = json.loads(out.decode(errors="replace").strip() or "null")
    except ValueError:
        return {"passed": False, "error": "OUTPUT_NOT_JSON"}
    return {"passed": True, "produced": produced}


async def _mcp_contract(workspace: Path, entry: dict[str, Any], sample: Any) -> dict[str, Any]:
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
    try:
        if not await _wait_for_port(port, _LAUNCH_TIMEOUT):
            await _terminate(proc)
            return {"passed": False, "error": "SERVICE_DID_NOT_START",
                    "stderr": f"启动命令 {' '.join(start)} 在 {int(_LAUNCH_TIMEOUT)}s 内没有监听 PORT={port}"}
        url = f"http://127.0.0.1:{port}/mcp"
        session, _ = await asyncio.to_thread(_mcp_post, url, {
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                       "clientInfo": {"name": "finance-skill-migration", "version": "0.1.0"}}})
        await asyncio.to_thread(_mcp_post, url, {"jsonrpc": "2.0", "method": "notifications/initialized"}, session)
        _, listed = await asyncio.to_thread(_mcp_post, url, {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}, session)
        tools = ((listed or {}).get("result") or {}).get("tools") or []
        name = str(entry.get("toolName") or "")
        observed = next((tool for tool in tools if tool.get("name") == name), None)
        if observed is None:
            return {"passed": False, "advertisedTools": [tool.get("name") for tool in tools],
                    "error": f"TOOL_NOT_ADVERTISED: {name}"}
        drift = []
        if observed.get("inputSchema") != entry.get("inputSchema"):
            drift.append({"where": "inputSchema", "baseline": entry.get("inputSchema"), "observed": observed.get("inputSchema")})
        _, called = await asyncio.to_thread(_mcp_post, url, {
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
                               "description": "Workspace-relative entry file. Required for SCRIPT; ignored for MCP, whose service is started instead."},
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

    # The sample is what the analysis read out of the package. Without one the call cannot be
    # exercised -- so the gate "调得通" is not checkable. Say that instead of feeding the tool
    # an invented `{}` and calling whatever it does a pass.
    if entry.get("sampleMissing") and not entry.get("sampleInput"):
        return {"passed": True, "toolId": tool_id, "callExecuted": False,
                "note": f"NO_SAMPLE: {entry['sampleMissing']}"}
    sample = entry.get("sampleInput") or {}
    ok, detail = _shape_ok(sample, entry.get("inputSchema"))
    if not ok:
        return {"passed": False, "toolId": tool_id, "inputShapeOk": False, "error": f"SAMPLE_INPUT_SHAPE: {detail}"}

    form = str(entry.get("form", "SCRIPT")).upper()
    if form == "MCP":
        outcome = await _mcp_contract(workspace, entry, sample)
    else:
        chosen = str(entrypoint or "")
        source = (workspace / chosen).resolve()
        if workspace.resolve() not in source.parents or not source.is_file():
            return {"passed": False, "toolId": tool_id, "error": f"ENTRYPOINT_MISSING: {chosen}"}
        outcome = await _script_contract(workspace, entry, source, sample)
    if not outcome.get("passed"):
        return {"passed": False, "toolId": tool_id, **{k: v for k, v in outcome.items() if k != "passed"}}
    # Drift from the baseline is reported, never a stop: migration adapts on purpose. The
    # reasons for what changed come from the agent's own delivery notes.
    drift = outcome.get("drift") or []
    if form != "MCP":
        shape_ok, shape_detail = _shape_ok(outcome.get("produced"), entry.get("outputSchema"))
        if not shape_ok:
            drift.append({"where": "outputShape", "baseline": entry.get("outputSchema"), "observed": shape_detail})
    return {
        "passed": True,
        "toolId": tool_id,
        "inputShapeOk": True,
        "contractPassed": True,
        "drift": drift,
        "error": "",
    }
