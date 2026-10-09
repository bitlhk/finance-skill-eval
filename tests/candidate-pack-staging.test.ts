import { createHash } from 'node:crypto';
import { mkdtemp, readFile, mkdir, writeFile, rm, symlink, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { stageCandidatePack, type CandidatePackInput } from '../src/service/candidate-pack-staging.js';
import { loadEvalPack } from '../src/eval-pack.js';
import { SkillStore } from '../src/service/skill-store.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const digest = (b: Buffer) => createHash('sha256').update(b).digest('hex');
async function fixture(declaration = 'allowed-tools: [curated_get_customer_profile, curated_list_products, curated_get_product_detail]') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'candidate-pack-')); roots.push(root);
  const source = path.join(root, 'source'); await mkdir(source);
  const originalRoot = path.resolve('packs/finance/auto-insurance-advisor-online');
  const pack = YAML.parse(await readFile(path.join(originalRoot, 'eval.yaml'), 'utf8'));
  for (const file of ['eval.yaml', pack.judgeProfileFile, ...pack.caseFiles, ...pack.holdoutCaseFiles]) {
    await mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await writeFile(path.join(source, file), await readFile(path.join(originalRoot, file)));
  }
  const archive = Buffer.from(zipSync({ 'SKILL.md': strToU8(`---\nname: auto-insurance-advisor\nversion: 0.1.0-curated.1\n${declaration}\n---\nUse the supplied facts.\n`),
    'references/source.md': strToU8('Immutable reference') }));
  const input: CandidatePackInput = { sourcePack: path.join(source, 'eval.yaml'), archive, archiveSha256: digest(archive),
    skillId: 'auto-insurance-advisor', skillVersion: '0.1.0-curated.1', packId: 'insurance-native-candidate', packVersion: '1.0.1',
    toolMapping: { get_customer_profile: 'curated_get_customer_profile', list_products: 'curated_list_products', get_product_detail: 'curated_get_product_detail' },
    outputDirectory: path.join(root, 'candidate') };
  return { root, source, pack, input };
}

describe('operator candidate staging without publication or admission', () => {
  it('pins actual Eval archive identity, preserves cases and holdout, and leaves the source unchanged', async () => {
    const { input } = await fixture();
    const before = await readFile(input.sourcePack);
    const old = await loadEvalPack(input.sourcePack);
    const result = await stageCandidatePack(input);
    const candidate = await loadEvalPack(path.join(input.outputDirectory, 'packs/candidate/eval.yaml'));
    expect(result.status).toBe('PREPARED_NOT_ACCEPTED');
    expect(result.runtimeAdmission).toBe('NOT_RUN');
    expect(result.professionalQuality).toBe('NOT_EVALUATED');
    expect(result.developmentCases).toBe(2); expect(result.holdoutCases).toBe(1);
    expect(candidate.variants.right).toMatchObject({ artifactSha256: result.asset.artifactSha256, version: input.skillVersion });
    expect(result.asset.artifactSha256).not.toBe(input.archiveSha256);
    expect(candidate.metadata.generationContext).toBe(old.metadata.generationContext);
    for (const [index, item] of [...candidate.cases, ...candidate.holdoutCases!].entries()) {
      const prior = [...old.cases, ...old.holdoutCases!][index]!;
      expect(item).toEqual({ ...prior, requiredTools: prior.requiredTools.map(name => input.toolMapping[name]) });
    }
    expect(await readFile(input.sourcePack)).toEqual(before);
    const store = new SkillStore(path.join(input.outputDirectory, 'state'));
    expect(Buffer.from((await store.readArchive(result.asset.assetId))['references/source.md']!).toString()).toBe('Immutable reference');
  });
  it('never overwrites an existing directory, even an empty one', async () => {
    const { input } = await fixture(); await mkdir(input.outputDirectory);
    await expect(stageCandidatePack(input)).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(access(input.outputDirectory)).resolves.toBeUndefined();
  });
  it('rejects a changed ZIP before creating output', async () => {
    const { input } = await fixture(); input.archiveSha256 = '0'.repeat(64);
    await expect(stageCandidatePack(input)).rejects.toThrow('DIGEST_MISMATCH');
    await expect(access(input.outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('requires explicit mappings rather than guessing prefixes', async () => {
    const { input } = await fixture(); input.toolMapping = {};
    await expect(stageCandidatePack(input)).rejects.toThrow('TOOL_MAPPING_MISSING');
  });
  it('rejects silent changes to an existing skill-versus-skill comparison', async () => {
    const { pack, input } = await fixture();
    pack.variants.left = { ...pack.variants.right };
    await writeFile(input.sourcePack, YAML.stringify(pack));
    await expect(stageCandidatePack(input)).rejects.toThrow('VARIANT_CHANGE_REQUIRES_REVIEW');
  });
  it('does not collapse two distinct tool expectations into one', async () => {
    const { input } = await fixture(); input.toolMapping.list_products = input.toolMapping.get_product_detail!;
    await expect(stageCandidatePack(input)).rejects.toThrow('TOOL_MAPPING_COLLISION');
  });
  it('supports explicitly no-tool methods without pretending a missing declaration is empty', async () => {
    const { source, pack, input } = await fixture('allowed-tools: []');
    for (const name of [...pack.caseFiles, ...pack.holdoutCaseFiles]) {
      const file = path.join(source, name), item = YAML.parse(await readFile(file, 'utf8'));
      item.requiredTools = []; await writeFile(file, YAML.stringify(item));
    }
    input.toolMapping = {};
    const result = await stageCandidatePack(input);
    expect(result.installedTools).toEqual([]);
    expect(result.status).toBe('PREPARED_NOT_ACCEPTED');
  });
  it('rejects mismatched method version and removes only its own incomplete stage', async () => {
    const { input } = await fixture(); input.skillVersion = '9.9.9';
    await expect(stageCandidatePack(input)).rejects.toThrow('VERSION_MISMATCH');
    await expect(access(input.outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(input.sourcePack)).resolves.toBeUndefined();
  });
  it('does not infer empty dependencies from missing declaration', async () => {
    const { input } = await fixture('');
    await expect(stageCandidatePack(input)).rejects.toThrow('EXPLICIT_TOOL_DECLARATION_REQUIRED');
  });
  it('rejects cases outside the actual installed method dependencies', async () => {
    const { input } = await fixture('allowed-tools: []');
    await expect(stageCandidatePack(input)).rejects.toThrow('案例工具不在 Skill 声明');
  });
  it('rejects source traversal and escaping symlinks', async () => {
    const { root, source, pack, input } = await fixture();
    await writeFile(path.join(root, 'outside.yaml'), 'not a case');
    await symlink(path.join(root, 'outside.yaml'), path.join(source, 'escape.yaml'));
    for (const file of ['../outside.yaml', 'escape.yaml']) {
      await writeFile(input.sourcePack, YAML.stringify({ ...pack, caseFiles: [file] }));
      await expect(stageCandidatePack(input)).rejects.toThrow('SOURCE_PATH_INVALID');
    }
  });
  it('preserves negative invocation constraints while translating explicit tool names', async () => {
    const { source, pack, input } = await fixture();
    const file = path.join(source, pack.caseFiles[0]);
    const c = YAML.parse(await readFile(file, 'utf8'));
    c.workspaceFiles = [{ path: 'evidence.txt', content: 'Only case 1' }];
    c.toolExpectations = { mustSucceed: ['get_customer_profile'], mustNotCall: ['list_products'] };
    await writeFile(file, YAML.stringify(c));
    await stageCandidatePack(input);
    const loaded = await loadEvalPack(path.join(input.outputDirectory, 'packs/candidate/eval.yaml'));
    expect(loaded.cases[0]?.toolExpectations).toEqual({ mustSucceed: ['curated_get_customer_profile'], mustNotCall: ['curated_list_products'] });
    expect(loaded.cases[0]?.workspaceFiles).toEqual(c.workspaceFiles);
  });
});
