# Fact provenance and evidence, V2

Existing reports are immutable. `fact-provenance-v2` is a new judging policy, not a
rewrite of prior PASS/FAIL results. New goal assessments resolve the exact Skill
artifact and provide its instructions to the judge. The extra source-boundary
criterion is separately labelled; it does not require bank facts to originate in
user input when the Skill permits tool sources. Additional rubric requirements
remain rubric requirements, not retroactive Skill obligations.

Unknown token totals are null, including partial accounting. Disabled tool-body
collection is not evidence of no calls. Per-case archive status is an execution
snapshot, not final archival state. New reports include the server checkout SHA
and whether it was dirty; old reports remain unlabelled when the version is unknown.

Launcher DELETE remains compatible with old acknowledgements. A new optional
cleanup observation records its time, instance and build identifiers, backend
retirement and limits of observation. Eval polls boundedly, then records PENDING
or UNKNOWN rather than inferring full cleanup. Reports capture that observation
after cleanup, before calculating the report fingerprint. This does not prove
absence of every OS process, nor independently verify temporary-candidate cleanup.

Compare same Skill digest, input, model parameters and business date. Preserve
original samples and scores; record execution completion, automatic quality and
human review separately. New login, live second-account isolation, executing-stage
cancellation and full resource reclamation need their own acceptance evidence.
