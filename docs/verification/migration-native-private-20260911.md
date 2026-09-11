# Native migration private delivery verification - 2026-09-11

## Scope and versions

Deployed implementation: `8e136ff6ccf720d056b518fccf20abeed38f8ee1` on
`feat/skill-migration-v01`. This is a private target-execution increment, not
original-runtime equivalence, professional optimization or formal publication.

- OpenJiuwen Java 0.1.13, Java 21; native SDK unchanged.
- Actual model: `glm-5.2`, external configured endpoint; no script model in live runs.
- Source: supplied PF method archive, with omitted implementation still unresolved.
- Business ports/data: this project's explicit synthetic financial statements.
- Candidate: `df4eba13a2b8862a2a6336a10a325043dc217b3180ffadfc4162514e4e206946`.
- Deployed Host class: `31b77d09f95bb0a9be83e0d1f1f55968a11a3044a806e02df6de0b8f911dfa24`.
- SDK JAR: `65561515ace2d44a1f2448d54fcdf2a2e09eadb8ba5be715836975f3fc4d64ea`.

## Actual checks

| Check | Result and boundary |
| --- | --- |
| Type checks and builds | TypeScript/core/web and native Maven package passed |
| Offline tests | 30 files, 92 tests passed; includes negative evidence/retry/staleness tests |
| Independent native reference | 7 checks passed: real model normal/zero/missing, denial, wrong digest/version, actual local grant revocation |
| PF browser/native test | 11 checks passed: generated archive actually loaded, real model/tools, refresh, edit invalidation, stale rejection, target unavailable, private auth/mobile |
| Private subpath browser | 13 checks passed using `/migration/` and private authentication header |
| Deployed private origin | 6 browser checks passed; normal/missing/denied target cases passed |
| Public gateway | Anonymous request remains HTTP 302 to existing authentication; no user SSO session exercised |
| Human independent use | Not run |

Deployed normal case: 63,757 ms, two successful financial tools and two model
responses. Missing case: 9,090 ms, both tools returned missing data and response
included the method's no-disclosure branch. Denial: 9 ms, no model requests or
business reads. These timings are single observations, not a latency benchmark.

The first PF trial failed at final output after both tools returned. It was not
accepted. After increasing the model response budget/timeout for this longer
method, a new local run and the deployed run passed. The failed report is retained.

## Evidence locations (private, not committed)

- `/home/ubuntu/outputs/migration-native-tests-20260911.json`
- `/home/ubuntu/outputs/native-migration-host-final-20260911.json`
- `/home/ubuntu/inputs/pf-skill-migration/native-web-20260911/` (failed first trial)
- `/home/ubuntu/inputs/pf-skill-migration/native-web-20260911-r2/`
- `/home/ubuntu/outputs/migration-prefix-final-20260911-r2/`
- `/home/ubuntu/inputs/pf-skill-migration/deployed-native-20260911/`

The deployed record is `target-7e7fe9ae-6596-4097-8be0-1027097889f7`, under
project `migration-8f249baa-20f4-4fa0-ab53-409805069f33`. UI project label:
`浦发方法结构 · 模拟目标验证 20260911`.

## Deployment and rollback

User entry: `https://finance-eval.demo.linggan.top/migration/`.
Testing used the actual deployed TLS origin `/migration/` proxy, not an invented
standalone page. Gateway SSO human login is separately unverified.

Private service switched at 09:35:18 CST; the public service retained its
2026-09-10 20:00:41 start time. No gateway or public anonymous-service changes.
The new Host is loopback-only on 56410. The private service stays on 56402.

Release directory:
`/home/ubuntu/.local/share/finance-skill-migration/releases/8e136ff`.
`release-manifest.json` records 254 actual built/dependency files and digests.
Credentials remain external; the release uses the machine's existing Node
dependencies, so it is not claimed as a self-contained portable distribution.

Preserved backups:
- `backups/workspace-before-8e136ff-20260911.tar.gz`: original assets/config/token.
- `backups/private-unit-before-20260911.service`: original unit configuration.
- `releases/rollback-5cf3325`: reconstructed prior released backend plus preserved
  original private web assets, not a claim to recover the previous in-memory process.
- `backups/rollback-private-5cf3325.service`: unit pointing to that fixed rollback.

All paths above are under `/home/ubuntu/.local/share/finance-skill-migration`.
The rollback backend was built and read current migration records: unauthorized
401, authenticated 200. Actual production rollback was not needed or exercised.

Rollback procedure: stop the private migration unit, copy the fixed rollback
unit to the user systemd unit path, daemon-reload, start and check authenticated
read access. Do not automatically restore the data backup over newer records.
Stop the native Host only after private traffic is no longer using it. Public
service and gateway are outside this rollback operation.

Private frontend build requires:

```sh
VITE_PRIVATE_WORKSPACE=true pnpm exec vite build --base=/migration/ --outDir=../web-dist-private
```

## Explicitly not accepted

Original missing PF implementations/output schemas, native AgentScope comparison,
business-rule contradictions, professional answer quality, edited-candidate
re-review workflow, optimization/formal release, independent human use, and
concurrent revocation timing beyond the tested local pre-call rejection. No
real customer data or bank transactions were used.
