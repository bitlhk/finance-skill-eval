"""Wait for the browser-started migration experiment and print a redacted result."""

import json
import os
import time
from urllib.request import Request, urlopen


BASE = os.environ.get("FINANCE_EVAL_URL", "http://127.0.0.1:56361")
TOKEN = os.environ.get("FINANCE_EVAL_ACCESS_TOKEN", "acceptance-local")


def get(path: str):
    request = Request(BASE + path, headers={"authorization": f"Bearer {TOKEN}"})
    with urlopen(request, timeout=30) as response:
        return json.load(response)


def main() -> int:
    projects = get("/api/migrations")
    project = next(item for item in projects if item["source"]["skillId"] == "openjiuwen-portability-acceptance")
    deadline = time.monotonic() + 310
    while time.monotonic() < deadline:
        report = get(f"/api/migrations/{project['id']}/report")
        experiment = report["experiments"][-1]
        if experiment["execution"] in {"completed", "failed", "cancelled", "interrupted"}:
            job = get(f"/api/runs/{experiment['jobId']}")
            result = {
                "projectId": project["id"],
                "jobId": experiment["jobId"],
                "execution": experiment["execution"],
                "evidence": experiment["evidence"],
                "openJiuwenStatus": report["verification"]["targetExecution"],
                "error": job.get("error"),
                "sides": [{
                    "caseId": item.get("caseId"),
                    "side": item.get("side"),
                    "status": item.get("status"),
                    "error": item.get("error"),
                    "tools": [call.get("name") for call in item.get("toolCalls", [])],
                    "hasLoadedDigest": bool(item.get("metadata", {}).get("skillArtifactSha256")),
                } for item in job.get("evidence", [])],
            }
            print(json.dumps(result, ensure_ascii=False))
            return 0 if experiment["execution"] == "completed" else 1
        time.sleep(2)
    raise TimeoutError("browser-started acceptance did not finish in time")


if __name__ == "__main__":
    raise SystemExit(main())
