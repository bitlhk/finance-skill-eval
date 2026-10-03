# Preparing native evaluation inputs

The method archive used by a Launcher probe and the Skill installed in Eval must
have the same bytes. A probe's JSON-content digest is not necessarily Eval's
archive-content fingerprint. Do not copy it into an Eval Pack as though the
algorithms were interchangeable.

`stage-candidate-pack.mjs` prepares a **new isolated directory**, using the existing
SkillStore and Eval Pack schemas. It never updates a running workspace, connection,
credential, qualification proof or asset admission. An existing output directory
is rejected. This is an operator release tool, not an upload-to-execute API.

After `pnpm build:core`, provide a JSON manifest with:

```json
{
  "sourcePack": "/fixed/source/eval.yaml",
  "archiveFile": "/fixed/tested/skill.zip",
  "archiveSha256": "<actual ZIP sha256>",
  "skillId": "<existing Skill ID>",
  "skillVersion": "<version inside the tested archive>",
  "packId": "<new candidate pack ID>",
  "packVersion": "1.0.0",
  "toolMapping": { "<original tool>": "<explicit admitted tool name>" },
  "outputDirectory": "/new/isolated/candidate"
}
```

Run `node scripts/stage-candidate-pack.mjs MANIFEST.json`. The result contains:

- `state/`: immutable imported Skill snapshot and its actual Eval fingerprint;
- `packs/candidate/`: version-pinned Eval Pack, original judge and cases;
- `staging.json`: original file digests, explicit tool mapping and new identity.

Prompts, customer references, workspace files, rubrics, holdout membership and
generation context are preserved. Only declared tool names are mapped. There is
no inferred prefix substitution, default customer selection or score rewrite.
Case tool dependencies must fit the method's explicit tool declaration. Existing
replay evidence cannot be repurposed as proof of native execution.

The result is `PREPARED_NOT_ACCEPTED`. In particular, successful staging does not
prove that preserved customer references match the target's trusted subject, that
the two runtime model settings are equal, or that a Provider is admitted. Those
remain runtime and release gates. No backend or UI should interpret this status as
ready for production.

For the controlled original-Skill cohort, the repeatable preparation check is:

```sh
node scripts/verify-curated-candidate-staging.mjs PROBE_ROOT NEW_OUTPUT SKILL_ID...
```

This consumes each explicitly selected probe's `skill.json` and `adaptation.json`.
It verifies the ZIP digest, then recomputes Eval's own fingerprint from the archive.
It does not install these per-Skill staging stores into the formal entry. All
featured catalog entries must be accounted for separately before promotion.
