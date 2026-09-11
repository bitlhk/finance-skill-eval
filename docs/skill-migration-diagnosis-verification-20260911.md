# Diagnosis/candidate revision: verification record

Base: `5cf3325`, branch `feat/skill-migration-v01`. This revision adds actual
diagnosis and generation; it does not represent completed native migration.

## Results

| Check | Observed result |
| --- | --- |
| TypeScript check and core/web build | Passed |
| Repository tests | 85 passed, 0 failed; 28 test files |
| Real-browser workflow, synthetic package | 13 checks passed |
| Private supplied package | 50 findings, all exact file/line snippets matched |
| Candidate export | Original non-method file bytes unchanged; metadata version plus six generated files |
| Real OpenJiuwen SDK Tool invocation | Generated Java compiled; allowed, denied-before-port and revoked-before-return probes passed |
| Real configured analysis model | glm-5.2, synthetic source only, 2 findings explained using valid IDs |
| Private review authentication | Anonymous 401; administrator catalog 200; Analyzer configured |
| Original AgentScope execution | NOT_RUN |
| Full target Agent Host and customer data tools | NOT_CONNECTED / NOT_RUN |
| Business migration, Harness publication, Builder import | NOT_VALIDATED |

The supplied package's dependency set includes explicit SDK imports and result
wrapping, host registration/custom schemas, implicit resource injection, missing
relative modules and omitted implementation. These are different layers of
findings. The sample's business terminology conflict is retained for its owner.
Original Python files were not imported or executed. No customer source was sent
in the real-model smoke; that smoke used generated synthetic material.

The SDK probe uses the actual `agent-core-java:0.1.13` jar, SHA-256
`65561515ace2d44a1f2448d54fcdf2a2e09eadb8ba5be715836975f3fc4d64ea`.
Dependencies were resolved from an existing local generated project with Maven.
This proves this generated tool boundary works with the SDK and controlled
callbacks, not that the missing customer query implementation works. The first
attempt compiled but could not run with the SDK jar alone because Jackson was
missing; the final probe uses the resolved classpath. It was not counted as a
successful standalone-jar run.

One intermediate regression exposed over-broad source-only project reuse: two
differently named experiments became one project. Reuse is now source digest
AND project name; the foreign-project-suite regression passes again. No test
assertion was relaxed to allow cross-project suites.

## Evidence locations (private machine, not public assets)

- `/home/ubuntu/outputs/migration-diagnosis-tests-final-20260911.json`
- `/home/ubuntu/outputs/skill-migration-diagnosis-ui-final-20260911/checks.json`
- `/home/ubuntu/outputs/migration-real-ai-20260911.json`
- `/home/ubuntu/inputs/pf-skill-migration/diagnosis-20260911-final/result.json`
- The last directory also contains the complete private diagnosis and candidate
  archive. Do not include these customer materials in a public repository.

## Preview and unchanged production

Review URL: `http://127.0.0.1:56403/`.
User service: `finance-skill-migration-review.service`.
Data and token: `.migration-review/` and `.migration-review/access-token`.
The token is generated locally and excluded from Git. The service is loopback
only and not enabled for public-domain routing. Its Analyzer configuration comes
from the existing local service environment; no secret is part of the build.

The public evaluation service, deployed `/migration/` workspace and gateway were
not restarted or rerouted for this review revision. Private customer material
was not auto-imported into the review service. Production publication should
follow review of the new commits and new evidence, not the old editor report.

## Next engineering slice

Wire the target Host to the proposed neutral declarations, reviewed schemas and
resource projections; use trusted context and exact loaded candidate digests.
Run a controlled end-to-end Agent/Host case before using completed original
AgentScope material for the AB/BC comparisons. Those tasks are this project's
engineering work, not all external material blockers. Do not mark a generated
adapter draft or a declared environment as native verification.
