# Cancellation, frozen retry, and tool evidence closeout

This change preserves previous jobs, outputs, scores and failure evidence.

## Findings

- Cancellation persisted only the parent status. Live child snapshots were rendered as current execution, while cleanup observations were attached only to successful reports.
- History retry used the saved backend configuration but restored only catalog pack selection in the UI. Uploaded preparations could therefore display the unrelated default Skill and cases.
- A model `providerId` is a configuration reference, not the side's Runtime identity. Side `runtimeBindings` choose the Launcher; case evidence records the observed runtime. New reports include the bindings separately.

## Changes

- Finalization is saved for cancelled/failed executions as well as successful reports, correlated to the evaluation job and native evaluation run. Evaluation-worker settlement does not assert termination of remote inference or every OS process.
- Terminal jobs display unfinished child data as a last snapshot. Old jobs without receipts remain unknown and are not rewritten.
- Retrying shows the saved configuration and the resolved cases, variants and model parameters, never defaults. Starting a new selection exits this view.
- Installed-tool inventory and attempt collection are displayed separately when provided. Missing collection remains unknown. A verified installation contract does not prove zero tool attempts.

## Verification and limits

- Offline runner tests cover cancellation cleanup, persistence, reload and retry without altering the original file.
- Browser script `scripts/verify-closeout-ui.mjs` uses isolated copies of the two reported jobs, stubs retry, and checks desktop/390/320px. It does not perform real inference or real SSO.
- Existing Judge results are unchanged. In particular the four meeting answers remain INDETERMINATE.
- Full native all-tool-attempt collection is not yet verified on both Java runtimes. The Builder addition reports installation-lock inventory and available callback events with explicit partial/unknown coverage. It must not be called complete collection.
- Fresh real-account login, two-account isolation, cancelled remote inference termination and OS-wide resource cleanup remain separate acceptance items. No 96-case rerun is part of this change.

Release identity and deployment receipts are recorded outside this document; a commit is not a deployment.
