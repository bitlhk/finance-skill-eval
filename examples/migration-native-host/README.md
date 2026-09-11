# Native migration reference Host

This is an independent, authenticated loopback OpenJiuwen Java 0.1.13 Host.
It loads an inert canonical archive, checks its digest and method identity, loads
explicit method resources, and installs one implemented synthetic read-only tool.
Uploaded Python/Java is never compiled or executed by the Host.

The Host uses a real configured model and the native Agent/Tool loop. Its business
source is an explicitly controlled fixture, NOT the original PF implementation.
The checked `mappingReview` declaration is not a publication approval or access
grant. The private generation API records explicit synthetic mapping review;
target verification binds the generated candidate. Actual access comes from
the Host's local grant.

## Reproduce the isolated smoke

Prerequisites: Java 21, Maven, Node 22, configured server-side
`FINANCE_EVAL_ANALYZER_MODEL`, `FINANCE_EVAL_ANALYZER_BASE_URL`, and
`FINANCE_EVAL_ANALYZER_API_KEY`. Never put keys in an uploaded Skill or artifact.

From this directory:

```sh
mvn -q package dependency:build-classpath -Dmdep.outputFile=target/classpath.txt
```

From the repository root, with model environment already loaded:

```sh
node scripts/verify-native-migration-host.mjs /absolute/path/result.json
```

The script creates its own temporary synthetic grant/fixtures and random token,
starts the actual Java Host on a free loopback port, tests normal/zero/missing
balances, denial and incorrect artifact/identity, then stops its process and
removes the temporary directory. Result files contain only synthetic business
facts and observed model/tool evidence. They do not contain model credentials.

## Web path and remaining scope

The private migration page now generates and runs the PF-method synthetic
candidate through this Host, with current-version evidence. See
`docs/migration-native-target-v01.md` at the repository root for the full path.

Remaining acceptance:

- Professional optimization, edited-candidate re-review and formal publication.
- Additional revocation timing and stale/retry/UI regression cases.
- Independent human operation and production identity integration.
- PF original implementation/native equivalence and Harness/Builder publication.

An isolated successful smoke does not complete any of these acceptance items.
