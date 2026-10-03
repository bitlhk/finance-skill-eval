# Bounded Synthetic MCP Source Candidate

This is a source transport for the existing fixed synthetic fixture, not a new
Agent Runtime, an upload executor, or admission of any Skill. It is not deployed.
The old `reference_mcp.py` entry and existing release configuration are unchanged.

The managed entry uses FastMCP's public stateless HTTP mode. There is no source
session identifier to adopt or delete. A request with a session header is rejected;
GET/DELETE and alternate paths are rejected. Business authority remains in the
Host and Harness Provider, not in this fixture server.

Bounds: four admitted HTTP requests, no waiting queue, 64 KiB request body,
256 KiB response body, 16 KiB application-visible headers, ten seconds per request
and one second for cancellation. These do not bound all OS/HTTP-parser allocations.
A dedicated source process exits with code 70 if its request task ignores
cancellation. This deliberately fails other requests in that process rather than
leaving unbounded work behind. Deployment must isolate this source from user
applications and handle failure/restart; it must not embed this middleware in a
shared production application. No child process or uploaded script is executed.

Startup requires an externally pinned, reviewed identity JSON:

```sh
python -m integrations.openjiuwen.bounded_reference_mcp \
  --port 56364 --identity /private/reviewed-source-identity.json \
  --identity-sha256 <reviewed-sha256>
```

The identity has schemaVersion `finance.synthetic-mcp-source.v1`, mode
`STATELESS_BOUNDED`, exact file digests for this wrapper and the three existing
fixture files, and distribution versions plus Python-file digests for mcp,
fastmcp, anyio, starlette and uvicorn. It does not claim to pin every transitive
native dependency; a deployed environment still needs its locked dependency
environment and qualification. The startup does not learn or approve a source
identity automatically. Test-only capture is in `test_bounded_reference_mcp.py`.

```sh
python -m unittest integrations.openjiuwen.test_bounded_reference_mcp \
  integrations.openjiuwen.test_reference_mcp
```

Tests run actual loopback TCP against owned child processes. They cover all normal
research calls after failures, explicit timeouts, disconnected response bodies,
oversized request/response, stateful headers, concurrency rejection and bounded
fail-stop of an intentionally uncooperative task. Source bytes, dependency drift
and incorrect manifest pins are rejected. Fault injection exists only in the
test child, not the managed entry. Every test reaps its child.

Harness source.v2 additionally pins `runtimePolicy.mode=STATELESS_BOUNDED` and
the source identity digest. A matching declaration alone is not a deployment
proof: actual source startup identity, Host configuration, installation Lock,
MCP output contracts and both Java Runtime qualifications must still be tied
together before admitting a curated Skill.
