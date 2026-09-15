"""Domain tools for the migration agents.

These are the only tools this project adds. Everything else (read / write / edit
/ grep / glob / list) comes from the harness -- and, deliberately, no shell.

Tools are the allowlist: an agent can only act through what it is handed here.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
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

async def _run_process(workspace: Path, argv: list[str], timeout: float) -> dict[str, Any]:
    proc = await asyncio.create_subprocess_exec(
        *argv, cwd=str(workspace),
        stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        env={**os.environ, "PYTHONUTF8": "1"},
    )
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


def build_compile_tool(workspace: Path) -> LocalFunction:
    async def compile_source(language: str = "python", paths: list[str] | None = None) -> dict[str, Any]:
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


def build_contract_test_tool(workspace: Path, contract: dict[str, Any]) -> LocalFunction:
    """`contract` maps toolId -> {entrypoint, inputSchema, outputSchema, sampleInput}."""

    async def run_contract_test(tool_id: str, entrypoint: str) -> dict[str, Any]:
        entry = contract.get(tool_id)
        if not entry:
            return {"passed": False, "error": f"UNKNOWN_TOOL_CONTRACT: {tool_id}"}
        # Schemas come from the source asset and cannot be supplied by the session;
        # only the entrypoint is the migration's choice.
        source = (workspace / str(entrypoint or "")).resolve()
        if workspace.resolve() not in source.parents or not source.is_file():
            return {"passed": False, "toolId": tool_id, "error": f"ENTRYPOINT_MISSING: {entrypoint}"}

        kind = str(entry.get("language", "python")).lower()
        if kind == "python":
            program = [sys.executable, "-I", str(source)]
        elif kind == "node":
            program = ["node", str(source)]
        else:
            return {"passed": False, "toolId": tool_id, "error": f"CONTRACT_TEST_UNSUPPORTED_LANGUAGE: {kind}"}

        sample = entry.get("sampleInput") or {}
        ok, detail = _shape_ok(sample, entry.get("inputSchema"))
        if not ok:
            return {"passed": False, "toolId": tool_id, "inputShapeOk": False, "error": f"SAMPLE_INPUT_SHAPE: {detail}"}

        proc = await asyncio.create_subprocess_exec(
            *program, cwd=str(workspace),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env={**os.environ, "PYTHONUTF8": "1"},
        )
        try:
            out, err = await asyncio.wait_for(proc.communicate(json.dumps(sample).encode()), 90)
        except TimeoutError:
            proc.kill()
            return {"passed": False, "toolId": tool_id, "error": "CONTRACT_TEST_TIMEOUT"}
        if proc.returncode != 0:
            return {"passed": False, "toolId": tool_id,
                    "error": f"EXIT_{proc.returncode}", "stderr": err.decode(errors="replace")[:1500]}
        try:
            produced = json.loads(out.decode(errors="replace").strip() or "null")
        except ValueError:
            return {"passed": False, "toolId": tool_id, "error": "OUTPUT_NOT_JSON"}

        shape_ok, shape_detail = _shape_ok(produced, entry.get("outputSchema"))
        return {
            "passed": bool(shape_ok),
            "toolId": tool_id,
            "inputShapeOk": True,
            "outputShapeOk": bool(shape_ok),
            "error": "" if shape_ok else f"OUTPUT_SHAPE: {shape_detail}",
        }

    return _tool(
        "run_contract_test",
        "Run the interface contract test for one migrated tool. The judged contract comes from the "
        "source asset (input/output shape), not from this session. It asserts the interface did not "
        "change, NOT that the business values are correct.",
        {
            "type": "object",
            "properties": {
                "tool_id": {"type": "string"},
                "entrypoint": {"type": "string", "description": "Workspace-relative path to the generated entry file."},
            },
            "required": ["tool_id", "entrypoint"],
            "additionalProperties": False,
        },
        run_contract_test,
    )
