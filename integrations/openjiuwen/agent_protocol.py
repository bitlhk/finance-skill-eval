"""Shared helpers for the migration agent entries.

Deliberately does NOT touch sys.stdout. Each entry point owns its own redirect --
doing it at import time in a shared module breaks as soon as one entry imports another.
"""
from __future__ import annotations

import json
import re
import sys
import tempfile
from pathlib import Path


def emit(protocol, value: dict) -> None:
    protocol.write(json.dumps(value, ensure_ascii=False, default=str) + "\n")
    protocol.flush()


def build_workspace(files: dict[str, str]) -> Path:
    """Materialise the request's files into a disposable directory.

    The harness agents scaffold their own home (AGENT.md, memory/, todo/ ...) into
    the workspace, so this must never point at the source tree.
    """
    root = Path(tempfile.mkdtemp(prefix="finance-migration-ws-")).resolve()
    for name, content in files.items():
        target = (root / name.replace("\\", "/")).resolve()
        if root not in target.parents:
            raise ValueError(f"Unsafe workspace path: {name}")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    return root


def _balanced_objects(text: str):
    """Yield every balanced {...} substring in order."""
    index = 0
    while True:
        start = text.find("{", index)
        if start < 0:
            return
        depth = 0
        in_string = False
        escaped = False
        end = -1
        for i in range(start, len(text)):
            ch = text[i]
            if in_string:
                if escaped:
                    escaped = False
                elif ch == "\\":
                    escaped = True
                elif ch == '"':
                    in_string = False
                continue
            if ch == '"':
                in_string = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    end = i
                    break
        if end < 0:
            return
        yield text[start:end + 1]
        index = end + 1


def parse_structured(output: str) -> dict:
    """Extract the agent's result object.

    The answer routinely arrives as prose that itself contains braces (e.g. the
    tool's own output shape), so 'first {' is wrong. Prefer a fenced block, and
    prefer a candidate that actually looks like a result (has a status field).
    """
    fenced = re.findall(r"```(?:json)?\s*(.*?)```", output, re.S)
    candidates: list[str] = []
    for block in fenced:
        candidates.extend(_balanced_objects(block))
    candidates.extend(_balanced_objects(output))

    parsed: list[dict] = []
    for candidate in candidates:
        try:
            value = json.loads(candidate)
        except ValueError:
            continue
        if isinstance(value, dict):
            parsed.append(value)

    for value in parsed:
        if str(value.get("status", "")).upper() in {"PRODUCED", "ABSTAINED"}:
            return value
    if parsed:
        return max(parsed, key=len)
    raise ValueError("NO_JSON_IN_OUTPUT")
