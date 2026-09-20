"""Local-only supervisor. Each execution owns a process, session and MCP clients."""
import asyncio
import json
import os
from pathlib import Path
import sys
import time

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from .model_config import resolve_model

app = FastAPI()
active = set()
cleanup_jobs = set()
slots = asyncio.Semaphore(2)
CONFIG = Path(os.environ.get("FINANCE_RUNTIME_CONFIG", ".runtime.local.json")).resolve()


def config():
    return json.loads(CONFIG.read_text())


@app.get("/health")
async def health():
    from importlib.metadata import version
    return {"status": "ready", "runtime": "openjiuwen", "version": version("openjiuwen"),
            "activeSessions": len(active), "maxConcurrentSessions": 2,
            "models": list(config().get("models", {})), "streaming": True,
            "mcpEndpoints": list(config().get("mcp", {}))}


@app.post("/execute")
async def execute(request: Request):
    body = await request.json()
    cfg = config()
    try:
        resolve_model(cfg, body.get("model", {}))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    for server in (body.get("environment") or {}).get("mcpServers", []):
        if server["endpoint"] not in cfg.get("mcp", {}):
            raise HTTPException(400, "MCP endpoint is not registered in this worker")
    for tool in (body.get("environment") or {}).get("scriptTools", []):
        if os.environ.get("FINANCE_EVAL_TRUSTED_LOCAL_SCRIPTS") != "1":
            raise HTTPException(403, "Local script execution is disabled")
        if tool.get("kind") not in ("PYTHON", "NODE") or not tool.get("name") or not tool.get("path"):
            raise HTTPException(400, "Invalid local Script Tool binding")
    if body.get("schemaVersion") != "finance.skill-eval.runtime-request.v1":
        raise HTTPException(400, "Unsupported runtime contract")

    async def stream():
        started = time.monotonic()
        async with slots:
            if await request.is_disconnected():
                return
            process = await asyncio.create_subprocess_exec(
                sys.executable, str(Path(__file__).with_name("session.py")),
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL, start_new_session=True,
                limit=1048576,
                env={**os.environ, "FINANCE_RUNTIME_CONFIG": str(CONFIG)},
            )
            active.add(process.pid)
            terminal = False
            try:
                process.stdin.write(json.dumps(body).encode())
                await process.stdin.drain()
                process.stdin.close()
                async with asyncio.timeout(300):
                    while True:
                        if await request.is_disconnected():
                            break
                        try:
                            line = await asyncio.wait_for(process.stdout.readline(), 0.5)
                        except TimeoutError:
                            continue
                        if not line:
                            break
                        try:
                            event = json.loads(line)
                        except ValueError:
                            continue
                        if "evidence" in event:
                            terminal = True
                        yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
            except TimeoutError:
                pass
            finally:
                # Client disconnect can cancel the generator while it is reaping.
                async def reap():
                    try:
                        if process.returncode is None:
                            try:
                                if os.name == "nt":
                                    process.terminate()
                                else:
                                    import signal
                                    os.killpg(process.pid, signal.SIGTERM)
                            except ProcessLookupError:
                                pass
                            try:
                                await asyncio.wait_for(process.wait(), 3)
                            except TimeoutError:
                                try:
                                    if os.name == "nt":
                                        process.kill()
                                    else:
                                        import signal
                                        os.killpg(process.pid, signal.SIGKILL)
                                except ProcessLookupError:
                                    pass
                                await process.wait()
                    finally:
                        active.discard(process.pid)
                cleanup = asyncio.create_task(reap())
                cleanup_jobs.add(cleanup)
                cleanup.add_done_callback(cleanup_jobs.discard)
                await asyncio.shield(cleanup)
            if not terminal:
                evidence = {"runId": body["runId"], "caseId": body["case"]["caseId"], "side": body["side"],
                            "status": "failed", "modelId": body["model"]["modelId"], "skillVersion": None,
                            "output": "", "elapsedMs": round((time.monotonic() - started) * 1000),
                            "toolCalls": [], "loadedSkills": [], "usage": None,
                            "runtimeIdentityVerified": False, "streamCompleted": False,
                            "error": "OpenJiuwen session stopped or exceeded 300 seconds", "metadata": {}}
                yield f"data: {json.dumps({'evidence': evidence})}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"})
