# Retesting a source Skill without replacing history

Migration records and candidate artifacts are distinct from source assets. Re-uploading identical source bytes can reuse the asset identity; it must not prevent a new migration revision.

## Migration

- Open the old record and choose **创建新修订**. This creates a new record from the same source, with a `revisionOf` link.
- Inspect and bind the new record against the current environment. Bindings, candidate, previous validation and runs are not inherited.
- **继续处理** still opens the original record. **重新生成** still replaces the candidate in that selected record; it is not the retest entry.
- New migration and upload entry points explicitly request a new record. Existing API clients keep deduplication unless they pass `createMode: "new"`.
- Compare source and candidate SHA-256, not only a version string such as `0.1.0` or ZIP timestamps.

## Original questions

In **Skill 资产 → 测试集**, choose the exact source asset and a historical preparation, then **使用所选测试集**. To import a separate copy, use **导入测试集副本** with the same simple JSON format as migration suites:

```json
{"name":"Original questions","cases":[{"id":"case-1","input":"Only summarize the facts I provide.","criteria":["Do not introduce environment information as user facts."]}]}
```

The import creates a fresh preparation ID. Existing test sets, migration records, scores and runs are unchanged. The current simple-suite limits and validation apply (1–8 cases); optional case files use the existing workspace-file schema. Import does not call a model or run a bank tool.

## Verification scope

Automated tests cover immutable old migration records, binding a new revision to a changed catalog, historical preparation selection, duplicate import copies and original prompt preservation. Browser checks cover both entry points and narrow screens. These checks do not re-score the original acceptance runs or prove model answer quality; that remains a separate new run using matched inputs and deployment evidence.
