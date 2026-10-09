# Unified Runtime acceptance, 2026-10-01

Status: candidate only; full release gates remain open. This report does not
authorize arbitrary uploaded code or claim all catalog Skills work on native
Harness Launchers.

## Fixed candidates and passed checks

- Harness: `db8e79cf875e69608b61d64c42bb26a57a29572d` (draft PR 35).
- Builder: `e2f63b35e6c1cd6fb5d1325acb830d42ef7ea594`, branch
  `feat/unified-eval-launcher-v1`; MR still needs to be created.
- Eval: `ebb0503` plus the incomplete-tool safety follow-up accompanying this
  document (draft PR 14).
- Builder full regression: 1,883 passed, 5 skipped.
- Eval full regression: 407 passed; typecheck and production build passed.
- Harness full Maven reactor passed, including both native file-tool adapters.

The controlled native acceptance ran 48 checks across OpenJiuwen Java 0.1.15
and AgentScope Java 2.0.3. Both runtimes read declared nonempty case files via
`read_case_file`, retained the actual file digest/read evidence and installation
Lock, isolated customer/session state and reclaimed owned candidates. The
requirements/build-delivery API built and installed new native candidates, and
Eval parsed the returned contract and canonical digest. The delivery probe made
no model or bank business calls. Operator-admitted proof is not a cryptographic
signature and is tied to the tested artifact identity.

A separate browser run uploaded the original supported read-only Skill ZIP and
ran two synthetic balance cases on each runtime using a real model. All four
answers passed explicit amount/currency checks, with native tool results, four
distinct sessions, method digest, Lock, history references and cleanup evidence.
The model gateway received the configured `deepseek-v4-flash`, temperature
`0.25`, top_p `0.8`, max_tokens `1234`. This is not human professional-quality
acceptance or a statistical ranking of the runtimes.

## Migration is not yet an end-to-end pass

The real migration analyzer identified the uploaded Skill's name-only tool
references as `INCOMPLETE`: neither implementation nor input/output contracts
were present. The migration UI currently offers MCP or script generation, not
explicit reuse of an admitted native Harness tool. Selecting a generation form
previously allowed this incomplete input to reach the implementation generator.

The follow-up blocks `INCOMPLETE` and `UNSUPPORTED` tools before generation.
The regression failed against the previous implementation and passes after the
change. An isolated browser/service probe verifies the explanatory message,
disabled generation action, HTTP 409 on direct generation and zero generator
calls. It uses recorded synthetic analysis, not a real-model success claim.

The earlier real migration generation process was intentionally terminated
after the missing-source condition was confirmed. It is retained as a failed
acceptance attempt, not described as a natural model timeout or a completed
migration. Its owned fixture exited cleanly. No business evaluation followed.

## Remaining release gates

1. Add explicit, versioned binding to admitted native tools for migration.
   A tool name alone cannot establish contract compatibility. Do not generate
   replacement bank implementations to bypass missing bindings.
2. Resolve the prebuilt Skill support scope. The seven existing entries include
   Wind, insurance, audit and lending dependencies that the managed QUERY
   Launcher has not admitted. A tool-free entry also cannot currently satisfy
   its nonempty financial-tool preset. Preserve these assets and explain missing
   support; do not silently substitute balance tools or mark them executable.
3. Repeat migrated and supported prebuilt paths from the page through native
   build, case evaluation, evidence and reclaim, including terminal failures.
4. Verify real public SSO login and denial for a second authenticated account.
   The requested admin maps to `studio_2`; controlled ingress isolation tests
   pass, but these are not proof of a real browser cookie-login journey.
5. Complete review/CI, Builder MR, immutable release preparation, protected
   unified ingress rollout and public acceptance. No production switch or data
   merge was performed for this increment. Issue 38 remains open.

## Local evidence index

Root: `/home/ubuntu/outputs/eval-unified-migration-runtime-v1/`

| Evidence | Meaning |
| --- | --- |
| `case-launcher-native-r3/report.json` | 48 controlled native checks and build delivery |
| `case-live-browser-r1/browser/report.json` | Uploaded Skill, real model, dual native runtimes |
| `case-live-browser-r1/browser/desktop-result.png` | Actual desktop result |
| `case-live-browser-r1/browser/mobile-result.png` | Actual 390px result |
| `migration-live-browser-r1/` | Failed migration attempt; intentional generator termination |
| `incomplete-ui-r2/report.json` | Guard browser/API regression, no generation |
| `builder-fixed.xml` | Full Builder regression |
| `eval-final-followup.json` | Full Eval regression |

Old production services and their state remain intact. A staged source release
directory exists but was not activated and predates this safety follow-up.
