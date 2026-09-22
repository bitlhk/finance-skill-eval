"""Local-only supervisor. Each execution owns a process, session and MCP clients."""
import asyncio
import json
import os
from pathlib import Path
import sys
import time

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from importlib.metadata import PackageNotFoundError, version
from .instance_manager import InstanceManager
from .model_config import resolve_model
from .runtime_context import RuntimeContext
from .package_runtime import service_environment

app = FastAPI()
active = set()
cleanup_jobs = set()
slots = asyncio.Semaphore(2)
instances = InstanceManager()
CONFIG = Path(os.environ.get("FINANCE_RUNTIME_CONFIG", ".runtime.local.json")).resolve()


def config():
    return json.loads(CONFIG.read_text())


@app.get("/health")
async def health():
    runtime_config = config()
    models = list(runtime_config.get("models", {}))
    return {"status": "ready", "runtime": "openjiuwen", "agentType": "DeepAgent", "version": runtime_version(),
            "activeSessions": len(active), "maxConcurrentSessions": 2,
            "models": models, "defaultModelId": runtime_config.get("defaultModelId") or (models[0] if models else None), "streaming": True,
            "mcpEndpoints": list(runtime_config.get("mcp", {}))}


def runtime_version():
    try:
        return version('openjiuwen')
    except PackageNotFoundError:
        return 'development'


@app.get('/v1/runtime-capabilities')
async def runtime_capabilities():
    runtime_config = config()
    models = [{'modelId': model_id,
               'upstreamModelId': model.get('upstreamModelId', model_id),
               **({'label': model['label']} if model.get('label') else {})}
              for model_id, model in runtime_config.get('models', {}).items()
              if model.get('enabled') is not False]
    default_model = runtime_config.get('defaultModelId') or (models[0]['modelId'] if models else None)
    if not models or not default_model:
        raise HTTPException(503, 'Runtime has no enabled execution model')
    return {'schemaVersion': 'finance.skill-eval.runtime-capabilities.v1',
            'runtime': {'type': 'openjiuwen', 'version': runtime_version()},
            'models': models, 'defaultModelId': default_model,
            'features': {'streaming': True, 'asyncLaunch': False, 'packagedMcp': True,
                         'externalMcp': False, 'inlineSecrets': True},
            'limits': {'maxArchiveBytes': instances.max_archive_bytes, 'maxFiles': instances.max_files,
                       'maxTimeoutMs': 900000, 'maxConcurrentInstances': 2}}


@app.post('/v1/runtime-instances')
async def create_runtime_instance(request: Request):
    body = await request.json()
    idempotency_key = request.headers.get('idempotency-key')
    if not idempotency_key or len(idempotency_key) > 200:
        raise HTTPException(400, 'A valid idempotency-key header is required')
    runtime_config = config()
    model = runtime_config.get('models', {}).get(body.get('modelId'))
    if not model or model.get('enabled') is False:
        raise HTTPException(400, 'Requested model is not configured in this Runtime')
    try:
        item = instances.create(body, idempotency_key)
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc
    except (ValueError, TypeError, KeyError) as exc:
        raise HTTPException(400, str(exc)) from exc
    return instances.public(item)


@app.get('/v1/runtime-instances/{instance_id}')
async def get_runtime_instance(instance_id: str):
    item = instances.get(instance_id)
    if not item:
        raise HTTPException(404, 'Runtime instance not found')
    return instances.public(item)


@app.delete('/v1/runtime-instances/{instance_id}')
async def delete_runtime_instance(instance_id: str):
    if not instances.delete(instance_id):
        raise HTTPException(404, 'Runtime instance not found')
    return Response(status_code=204)


class InstanceExecutionRequest:
    def __init__(self, body, source):
        self.body = body
        self.source = source

    async def json(self):
        return self.body

    async def is_disconnected(self):
        return await self.source.is_disconnected()


@app.post('/v1/runtime-instances/{instance_id}/execute')
async def execute_runtime_instance(instance_id: str, request: Request):
    try:
        body = instances.execution(instance_id, await request.json())
    except KeyError:
        raise HTTPException(404, 'Runtime instance not found') from None
    except (ValueError, TypeError) as exc:
        raise HTTPException(400, str(exc)) from exc
    model = config().get('models', {}).get(body['model']['modelId'], {})
    body['model']['providerId'] = model.get('providerId', 'service-execution')
    return await execute(InstanceExecutionRequest(body, request))


@app.post("/execute")
async def execute(request: Request):
    body = await request.json()
    cfg = config()
    try:
        RuntimeContext((body.get('environment') or {}).get('runtimeToolConfig'), cfg.get('authProviders', {}))
    except (ValueError, TypeError, KeyError):
        raise HTTPException(400, 'Invalid runtime context or auth configuration') from None
    try:
        resolve_model(cfg, body.get("model", {}))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    for server in (body.get("environment") or {}).get("mcpServers", []):
        if server["endpoint"] not in cfg.get("mcp", {}):
            raise HTTPException(400, "MCP endpoint is not registered in this worker")
    if "scriptTools" in (body.get("environment") or {}):
        raise HTTPException(400, "Legacy Script Tool registration is not supported")
    if "candidateHarnessPlugins" in (body.get("environment") or {}):
        raise HTTPException(400, "Candidate Harness plugins are not supported; rebuild the Runtime through Runtime Builder")
    harness = (body.get('environment') or {}).get('harnessToolNames', [])
    if not isinstance(harness, list) or any(name not in ('read_file', 'glob', 'list_files', 'bash') for name in harness):
        raise HTTPException(400, 'Unsupported requested Harness capability')
    command_scripts = (body.get("environment") or {}).get("commandScripts", [])
    if command_scripts and os.environ.get("FINANCE_EVAL_TRUSTED_LOCAL_SCRIPTS") != "1":
        raise HTTPException(403, "Local script execution is disabled")
    for tool in command_scripts:
        if tool.get("kind") not in ("PYTHON", "NODE") or not tool.get("name") or not tool.get("path"):
            raise HTTPException(400, "Invalid command script binding")
    for service in (body.get("environment") or {}).get("candidateMcpServices", []):
        try:
            service_environment(service.get("environment", {}))
        except ValueError:
            raise HTTPException(400, "Invalid candidate service environment")
        skill = body.get("skill") or {}
        if not service.get("start") or not service.get("toolNames") or service.get("assetDigest") != skill.get("artifactSha256") or service.get("assetDigest") != (body.get("variant") or {}).get("artifactSha256"):
            raise HTTPException(400, "Invalid candidate MCP artifact binding")
        if any(name not in skill.get("files", {}) for name in service.get("filePaths", [])):
            raise HTTPException(400, "Candidate MCP files are missing")
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
                env={**os.environ, "FINANCE_RUNTIME_CONFIG": str(CONFIG), "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
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
