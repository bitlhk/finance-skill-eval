# Skill migration workspace navigation

## Entry and workflow

In the authenticated private workspace, **Skill 迁移** is a first-level menu,
beside **Skill 资产**. Public demonstration mode does not expose this menu or
grant access to private migration APIs.

1. Open **Skill 迁移** to see persisted projects, source version, candidate
   version, target and verification status.
2. Choose **新建迁移**, then select an uploaded asset or upload a ZIP. Alternatively,
   use **发起迁移** on the asset page. Uploading to the asset page alone no longer
   automatically creates a migration project.
3. Follow **依赖诊断 → 映射与生成 → 目标验证 → 导出候选**.
4. Use **返回项目列表** to resume another project. Refreshing does not delete projects.

The export is a candidate archive, not a production release. The simulated
OpenJiuwen target proves candidate loading and controlled tool execution, not
equivalence to missing original bank implementations or professional acceptance.
Manual edits invalidate old verification. Supported re-generation and target
binding restrictions remain unchanged; this navigation update does not implement
automatic optimization or arbitrary-runtime integration.

## Verification

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
VITE_PRIVATE_WORKSPACE=true pnpm exec vite build --base=/migration/ --outDir=../web-dist-private
MIGRATION_TEST_WEB_DIR=web-dist-private MIGRATION_TEST_PREFIX=/migration/ MIGRATION_TEST_PRIVATE_GATEWAY=true node scripts/verify-migration-ui.mjs reports/migration-ui
```

The local run on 2026-09-11 passed 92 tests in 30 files and 16 browser checks.
Browser coverage includes private login, separate asset and project pages,
asset-to-migration entry, generation/edit/export, stale validation rejection,
refresh persistence and desktop/mobile layouts. It uses synthetic data, not a
live model. Earlier live-model evidence remains a separate record.

## Consolidated merge scope

The migration branch contains the linear ancestors `feat/risk-review-eval-v1`
and `feat/standalone-eval-service-v1`. One migration-to-main PR therefore includes
the risk review and standalone service foundation as well as migration work,
not just this menu change. The preserved historical service snapshot is included;
passing regression tests does not mean every historical line received an
independent review. CI adds offline TypeScript, unit, build, native Java compile
and authenticated browser checks without live credentials.

No workspace archive, administrator token, model credential or customer material
is part of this change. Deployment must preserve private data and use the
private `/migration/` build; it must not replace the public demonstration bundle.
