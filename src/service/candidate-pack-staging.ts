import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { evalCaseSchema, evalPackFileSchema, judgeProfileSchema } from '../contracts.js';
import { loadEvalPack } from '../eval-pack.js';
import { SkillStore } from './skill-store.js';
import { skillRuntimeRequirements } from '../shared/skill-runtime-requirements.js';

export interface CandidatePackInput {
  sourcePack: string;
  archive: Buffer;
  archiveSha256: string;
  skillId: string;
  skillVersion: string;
  packId: string;
  packVersion: string;
  toolMapping: Record<string, string>;
  outputDirectory: string;
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Operator-only staging: never edits a running workspace, environment or admission. */
export async function stageCandidatePack(input: CandidatePackInput) {
  if (!/^[a-f0-9]{64}$/u.test(input.archiveSha256) || sha256(input.archive) !== input.archiveSha256)
    throw Error('CANDIDATE_ARCHIVE_DIGEST_MISMATCH');
  const sourceFile = await realpath(input.sourcePack);
  const sourceRoot = path.dirname(sourceFile);
  const sourceDigests: Record<string, string> = {};
  async function sourceYaml(relative: string) {
    if (path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').includes('..'))
      throw Error('CANDIDATE_SOURCE_PATH_INVALID');
    const file = await realpath(path.resolve(sourceRoot, relative));
    const inside = path.relative(sourceRoot, file);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw Error('CANDIDATE_SOURCE_PATH_INVALID');
    const bytes = await readFile(file);
    if (bytes.length > 2 * 1024 * 1024) throw Error('CANDIDATE_SOURCE_TOO_LARGE');
    sourceDigests[relative] = sha256(bytes);
    return YAML.parse(bytes.toString('utf8'));
  }
  const original = evalPackFileSchema.parse(await sourceYaml(path.basename(sourceFile)));
  if (original.targetSkillId !== input.skillId) throw Error('CANDIDATE_SKILL_ID_MISMATCH');
  if (original.variants.left.mode !== 'without_target_skill' || original.variants.right.mode !== 'skill_version'
      || original.variants.left.skillId !== input.skillId || original.variants.right.skillId !== input.skillId)
    throw Error('CANDIDATE_VARIANT_CHANGE_REQUIRES_REVIEW');
  if (new Set(Object.values(input.toolMapping)).size !== Object.keys(input.toolMapping).length)
    throw Error('CANDIDATE_TOOL_MAPPING_COLLISION');
  if (!input.packId.trim() || input.packId === original.packId || !input.packVersion.trim())
    throw Error('CANDIDATE_REQUIRES_SEPARATE_PACK_ID');
  const profile = judgeProfileSchema.parse(await sourceYaml(original.judgeProfileFile));
  const mapTools = (names: string[]) => names.map(name => {
    const target = Object.hasOwn(input.toolMapping, name) ? input.toolMapping[name] : undefined;
    if (!target || target.trim() !== target || target === '*') throw Error(`CANDIDATE_TOOL_MAPPING_MISSING: ${name}`);
    return target;
  });
  const cases = await Promise.all([...original.caseFiles, ...(original.holdoutCaseFiles ?? [])].map(async file => {
    const item = evalCaseSchema.parse(await sourceYaml(file));
    if (item.replay) throw Error('CANDIDATE_REPLAY_REQUIRES_SEPARATE_EVIDENCE');
    return { ...item, requiredTools: mapTools(item.requiredTools), ...(item.toolExpectations ? {
      toolExpectations: { mustSucceed: mapTools(item.toolExpectations.mustSucceed), mustNotCall: mapTools(item.toolExpectations.mustNotCall) },
    } : {}) };
  }));
  if (new Set(cases.map(c => c.caseId)).size !== cases.length) throw Error('CANDIDATE_DUPLICATE_CASE_ID');
  const output = path.resolve(input.outputDirectory);
  // Exclusive creation prevents replacement of a deployed release or old evidence.
  await mkdir(output, { recursive: false, mode: 0o700 });
  try {
    const store = new SkillStore(path.join(output, 'state'));
    await store.initialize();
    const asset = await store.uploadZip(input.archive);
    if (asset.skillId !== input.skillId || asset.version !== input.skillVersion) throw Error('CANDIDATE_SKILL_VERSION_MISMATCH');
    const instructions = await store.readSource(asset.assetId);
    const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(instructions);
    const metadata = front ? YAML.parse(front[1]!) : null;
    if (!metadata || (!Object.hasOwn(metadata, 'allowed-tools') && !Object.hasOwn(metadata, 'allowedTools')))
      throw Error('CANDIDATE_EXPLICIT_TOOL_DECLARATION_REQUIRED');
    const installedTools = skillRuntimeRequirements(instructions, cases.flatMap(c => [...c.requiredTools, ...(c.toolExpectations?.mustSucceed ?? [])]));
    const caseFiles = cases.map((_, i) => `cases/${i + 1}.yaml`);
    const candidate = evalPackFileSchema.parse({ ...original, packId: input.packId, version: input.packVersion,
      targetSkillVersion: asset.version, variants: {
        left: { mode: 'without_target_skill', skillId: asset.skillId },
        right: { mode: 'skill_version', skillId: asset.skillId, version: asset.version, artifactSha256: asset.artifactSha256 },
      }, judgeProfileFile: 'profiles/judge.yaml', caseFiles: caseFiles.slice(0, original.caseFiles.length),
      holdoutCaseFiles: caseFiles.slice(original.caseFiles.length), metadata: { ...original.metadata,
        candidateStatus: 'PREPARED_NOT_ACCEPTED', sourcePackId: original.packId, sourcePackVersion: original.version,
        sourceArchiveSha256: input.archiveSha256, evidenceSemantics: 'candidate-inputs-only-not-runtime-or-quality-acceptance',
      },
    });
    const packDirectory = path.join(output, 'packs', 'candidate');
    await mkdir(path.join(packDirectory, 'cases'), { recursive: true });
    await mkdir(path.join(packDirectory, 'profiles'));
    await writeFile(path.join(packDirectory, 'eval.yaml'), YAML.stringify(candidate));
    await writeFile(path.join(packDirectory, 'profiles/judge.yaml'), YAML.stringify(profile));
    for (const [index, item] of cases.entries()) await writeFile(path.join(packDirectory, caseFiles[index]!), YAML.stringify(item));
    const loaded = await loadEvalPack(path.join(packDirectory, 'eval.yaml'));
    const report = { schemaVersion: 'finance.eval.candidate-staging.v1', status: 'PREPARED_NOT_ACCEPTED',
      asset, archiveSha256: input.archiveSha256, sourceDigests, toolMapping: input.toolMapping, installedTools,
      packId: loaded.packId, packVersion: loaded.version, packFingerprint: loaded.packFingerprint,
      developmentCases: loaded.cases.length, holdoutCases: loaded.holdoutCases?.length ?? 0,
      caseContent: 'PROMPTS_RUBRICS_WORKSPACE_AND_CONTEXT_UNCHANGED',
      runtimeAdmission: 'NOT_RUN', runtimeExecution: 'NOT_RUN', professionalQuality: 'NOT_EVALUATED' };
    await writeFile(path.join(output, 'staging.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    return report;
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}
