# Prebuilt balance browser verification

The existing `scripts/verify-launcher-ui.mjs` accepts `LAUNCHER_FIXTURE_MAP` as a
private JSON file mapping `oj` and `as` to separately qualified Launcher fixture
descriptors. This is useful when their exact Host artifact identities differ.
It does not relax Launcher admission or change the product's environment model.

For `LAUNCHER_PREBUILT_FLOW=true`, each descriptor must identify the evaluation
pack's fixture version. The browser selects the existing catalog Skill and both
environments, submits one generation configuration, and checks actual tool,
workspace, Lock, history and session evidence. Desktop and 390px screenshots are
retained. Tokens are confined to the isolated fixture configuration.

`packs/finance/native-readonly-balance/fixtures/accounts-20261002.json` records
the account/currency/available-balance subset of an independent synthetic source
read. Its raw response hash is provenance, not a signature. It is never used to
generate model answers. New simulator instances have new timestamps; answer time
must match the current actual tool response, not this frozen baseline.

The paired Builder `engineering/verify_balance_native_browser.py` orchestrates
owned synthetic banks and performs the additional offline source comparison:
frozen account tuples, independent before/after reads, actual bank HTTP, Provider
projection, answer, case-file marker and recorded terminal completeness. Browser
success alone is not that fact verification. The former single-account 12345.67
matcher is explicitly rejected for this five-account prebuilt case.

These checks use a controlled model and do not prove professional quality,
real-model performance, administrator SSO or production deployment. Keep those
release gates separate; do not infer full featured-catalog acceptance from this
single Skill.
