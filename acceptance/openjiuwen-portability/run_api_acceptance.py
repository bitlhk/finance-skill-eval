"""Run the deterministic Skill against the local OpenJiuwen HTTP endpoint."""

from hashlib import sha256
import json
import os
from pathlib import Path
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
SKILL = ROOT / "skill"
ENDPOINT = os.environ.get("FINANCE_OPENJIUWEN_ENDPOINT", "http://127.0.0.1:56362/execute")


def load_files() -> dict[str, str]:
    files: dict[str, str] = {}
    for path in SKILL.rglob("*"):
        if not path.is_file() or "__pycache__" in path.parts or any(part.startswith(".venv") for part in path.parts):
            continue
        files[path.relative_to(SKILL).as_posix()] = path.read_text(encoding="utf-8")
    return files


def main() -> int:
    files = load_files()
    canonical = json.dumps(files, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    digest = sha256(canonical).hexdigest()
    payload = {
        "schemaVersion": "finance.skill-eval.runtime-request.v1",
        "runId": "acceptance-api-order-001",
        "side": "right",
        "case": {
            "caseId": "PORTABILITY-HAPPY-001",
            "prompt": "Use the acceptance workflow to calculate the final total for ORDER-001.",
            "taskMode": "single_turn",
            "requiredTools": ["get_acceptance_order", "calculate_acceptance_total"],
        },
        "model": {"providerId": "service-execution", "modelId": "enterprise-model"},
        "variant": {
            "mode": "skill_version",
            "skillId": "openjiuwen-portability-acceptance",
            "version": "1.0.0",
        },
        "skill": {
            "skillId": "openjiuwen-portability-acceptance",
            "version": "1.0.0",
            "artifactSha256": digest,
            "instructions": files["SKILL.md"],
            "files": files,
        },
        "environment": {
            "environmentId": "openjiuwen-portability-acceptance",
            "requiredToolNames": ["get_acceptance_order", "calculate_acceptance_total"],
            "mcpServers": [{
                "serverId": "acceptance-orders",
                "endpoint": "http://127.0.0.1:56364/mcp",
                "transport": "streamable_http",
                "toolNames": ["get_acceptance_order"],
            }],
            "scriptTools": [{
                "name": "calculate_acceptance_total",
                "path": "scripts/calculate_acceptance_total.py",
                "kind": "PYTHON",
                "filePaths": [
                    "scripts/calculate_acceptance_total.py",
                    "scripts/pyproject.toml",
                    "scripts/uv.lock",
                ],
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "subtotal": {"type": "string"},
                        "tax_rate": {"type": "string"},
                    },
                    "required": ["subtotal", "tax_rate"],
                    "additionalProperties": False,
                },
            }],
        },
    }
    request = Request(ENDPOINT, json.dumps(payload).encode(), {"content-type": "application/json"}, method="POST")
    evidence = None
    with urlopen(request, timeout=310) as response:
        for raw in response:
            line = raw.decode("utf-8").strip()
            if not line.startswith("data:"):
                continue
            event = json.loads(line.removeprefix("data:").strip())
            if "evidence" in event:
                evidence = event["evidence"]
    if evidence is None:
        raise AssertionError("OpenJiuwen stream ended without evidence")
    if evidence["status"] != "completed":
        raise AssertionError(f"OpenJiuwen execution failed: {evidence.get('error')}")
    calls = {call["name"]: call["status"] for call in evidence["toolCalls"]}
    assert calls.get("get_acceptance_order") == "completed"
    assert calls.get("calculate_acceptance_total") == "completed"
    assert "references/acceptance-policy.md" in evidence["metadata"]["referenceFilesRead"]
    output = evidence["output"]
    for expected in ("ACCEPTANCE_RESULT", "ORDER-001", "100.00", "6.00", "106.00"):
        assert expected in output, f"missing expected result: {expected}"
    print(json.dumps({
        "status": "PASSED",
        "caseId": evidence["caseId"],
        "skillDigest": digest,
        "tools": calls,
        "referenceRead": True,
        "expectedTotal": "106.00",
        "runtime": evidence["metadata"]["runtimeVersion"],
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
