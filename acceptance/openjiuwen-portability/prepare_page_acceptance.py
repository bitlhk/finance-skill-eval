"""Register the local MCP and OpenJiuwen endpoints used by the page acceptance."""

import json
import os
from pathlib import Path
from urllib.request import Request, urlopen


BASE = os.environ.get("FINANCE_EVAL_URL", "http://127.0.0.1:56361")
TOKEN = os.environ.get("FINANCE_EVAL_ACCESS_TOKEN", "acceptance-local")


def call(path: str, payload: dict | None = None):
    headers = {"authorization": f"Bearer {TOKEN}"}
    data = None
    method = "GET"
    if payload is not None:
        headers["content-type"] = "application/json"
        data = json.dumps(payload).encode()
        method = "POST"
    with urlopen(Request(BASE + path, data=data, headers=headers, method=method), timeout=30) as response:
        return json.load(response)


def upload_skill(filename: str):
    artifact = Path(__file__).resolve().parents[2] / "artifacts" / filename
    headers = {"authorization": f"Bearer {TOKEN}", "content-type": "application/zip"}
    request = Request(BASE + "/api/skills/upload", data=artifact.read_bytes(), headers=headers, method="POST")
    with urlopen(request, timeout=30) as response:
        return json.load(response)


def main() -> int:
    catalog = call("/api/catalog")
    environments = catalog.get("environments", [])
    source = upload_skill("openjiuwen-portability-legacy-1.0.0.zip")
    completed = upload_skill("openjiuwen-portability-completed-2.0.0.zip")
    mcp = next((item for item in environments if item["name"] == "Acceptance orders MCP"), None)
    if mcp is None:
        mcp = call("/api/environments", {
            "name": "Acceptance orders MCP",
            "type": "mcp_streamable_http",
            "endpoint": "http://127.0.0.1:56364/mcp",
            "mcpEnvironmentIds": [],
        })
    runtime = next((item for item in environments if item["name"] == "Local OpenJiuwen acceptance"), None)
    if runtime is None:
        runtime = call("/api/environments", {
            "name": "Local OpenJiuwen acceptance",
            "type": "runtime_http",
            "runtimeType": "openjiuwen",
            "endpoint": "http://127.0.0.1:56362/execute",
            "mcpEnvironmentIds": [mcp["environmentId"]],
        })
    print(json.dumps({
        "status": "READY",
        "mcpEnvironmentId": mcp["environmentId"],
        "runtimeEnvironmentId": runtime["environmentId"],
        "sourceAssetId": source["assetId"],
        "completedAssetId": completed["assetId"],
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
