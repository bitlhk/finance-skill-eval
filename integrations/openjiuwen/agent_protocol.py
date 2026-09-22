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


ANALYSIS_TEXT_EXTENSIONS = {".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".java", ".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".xml", ".html", ".css", ".sql", ".sh", ".ps1", ".ini", ".cfg", ".rst"}


def build_workspace(files: dict[str, str | bytes], *, normalize_text: bool = False) -> Path:
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
        # Normalize only recognized UTF-8 text in the analysis copy. Binary assets stay byte-exact.
        text = content if isinstance(content, str) else None
        if normalize_text and target.suffix.lower() in ANALYSIS_TEXT_EXTENSIONS:
            if text is None:
                try:
                    text = content.decode("utf-8")
                    if "\x00" in text:
                        text = None
                except UnicodeDecodeError:
                    pass
            if text is not None:
                text = text.replace("\r\n", "\n").replace("\r", "\n")
                target.write_text(text, encoding="utf-8", newline="\n")
                continue
        if isinstance(content, bytes):
            target.write_bytes(content)
        else:
            target.write_text(content, encoding="utf-8")
    return root


MAX_ITERATION_SENTINEL = "Max iterations reached without completion"


def not_json_reason(result: object, exc: Exception, budget: int) -> str:
    """Why there was no JSON to parse.

    A ReAct loop that runs out of its iteration budget does not return a model answer at all: the
    harness replaces it with a fixed sentence (`react_agent.py`), so the parse fails and every
    reader downstream is told the model "did not answer in JSON". That names the symptom and hides
    the cause, and the two have different fixes -- a bigger budget, or a cheaper task, versus
    telling the model again what shape to answer in.
    """
    output = str(result.get("output", "")) if isinstance(result, dict) else ""
    kind = str(result.get("result_type", "")) if isinstance(result, dict) else ""
    if MAX_ITERATION_SENTINEL in output:
        return (f"agent 用完了 {budget} 轮迭代预算也没有交付结果。这不是回答格式的问题："
                f"Harness 在预算耗尽时不会返回模型回答，只回一句 {MAX_ITERATION_SENTINEL}。"
                "请提高预算或把任务拆小")[:600]
    if kind == "interrupt":
        return f"agent 被中断，没有给出结果：{output.strip()[:200]}"[:600]
    if kind == "error":
        return f"agent 以错误结束，没有给出结果：{output.strip()[:200]}"[:600]
    if not output.strip():
        # Nothing came back and the loop did not say why. The result's fields are the one thing that
        # separates "the model answered with nothing" from "the harness dropped the answer": a
        # reasoning model that spends its whole output budget on `reasoning_content` finishes with
        # an empty `content`, and that is fixed with a larger max_tokens, not a better prompt.
        keys = sorted(result) if isinstance(result, dict) else []
        return (f"agent 没有给出任何输出（空回答），harness 也没有报错。返回的字段：{keys}。"
                "推理模型把整个输出预算用在 reasoning 上时会这样收尾")[:600]
    return f"结果不是约定的 JSON：{exc}"[:600]


def write_agent_dump(name: str, content: str) -> None:
    """Keep what the agent actually said, where whoever reads the failure can find it.

    The failure message tells the reader to go and look at the agent's log, so there has to be one.
    Off unless `FINANCE_EVAL_AGENT_DUMP` names a directory: this is the agent's own answer, and it
    is written for an operator to read rather than into anything that ships.
    """
    import os

    directory = os.environ.get("FINANCE_EVAL_AGENT_DUMP", "").strip()
    if not directory:
        return
    try:
        target = Path(directory)
        target.mkdir(parents=True, exist_ok=True)
        (target / f"{name}.txt").write_text(content, encoding="utf-8")
    except OSError:
        # A dump that cannot be written must never be the reason a run reports no result.
        pass


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
    broken: str = ""
    for candidate in candidates:
        try:
            value = json.loads(candidate)
        except ValueError as exc:
            broken = broken or str(exc)
            continue
        if isinstance(value, dict):
            parsed.append(value)

    for value in parsed:
        if str(value.get("status", "")).upper() in {"PRODUCED", "ABSTAINED"}:
            return value
    if parsed:
        return max(parsed, key=len)
    if fenced and broken == "" and not candidates:
        # A fenced block whose braces never balance: the answer *was* meant to be JSON and is
        # malformed, which is a different problem from prose -- and the fix is different too.
        raise ValueError("JSON_UNBALANCED: 围栏里的 JSON 括号不配对（多半是某个字符串没闭合）")
    if broken:
        raise ValueError(f"JSON_INVALID: {broken}")
    raise ValueError("NO_JSON_IN_OUTPUT")
