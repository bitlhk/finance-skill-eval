import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { unzipSync, zipSync } from 'fflate';
import { canonicalSha256 } from '../../../shared/json-canonicalization.js';
import { simpleMigrationSuiteSchema } from '../../domain/simple-migration-suite.js';
import type { RuntimeExecutionEvidence } from '../../../contracts.js';

export const bundleIdSchema = z.string().regex(/^bundle-[a-f0-9-]+$/);
export const pathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (value) =>
      !value.includes('\\') &&
      !value.includes(':') &&
      !/[\x00-\x1f]/.test(value) &&
      value
        .split('/')
        .every(
          (part) =>
            part !== '' &&
            part !== '.' &&
            part !== '..' &&
            !/[. ]$/.test(part) &&
            !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
        ),
    '路径必须位于工程内',
  );
export const memberSchema = z.strictObject({
  id: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .max(80),
  skillId: z.string().min(1).max(200),
  skillFile: pathSchema,
  version: z.string(),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type BundleMember = z.infer<typeof memberSchema>;
export type BundleFiles = Record<string, string>; // canonical base64, including binary resources
export type BundleSnapshot = {
  digest: string;
  members: BundleMember[];
  files: BundleFiles;
  entryInstructionsFile?: string;
};
export const configurationSchema = z.strictObject({
  environmentId: z.string().min(1),
  modelId: z.string().min(1),
  timeoutMs: z.number().int().min(10000).max(900000).default(310000),
  entryInstructionsFile: pathSchema.optional(),
  harnessTools: z
    .array(z.enum(['read_file', 'glob', 'list_files', 'bash']))
    .max(4)
    .default(['read_file', 'glob', 'list_files']),
});
export type BundleConfiguration = z.infer<typeof configurationSchema>;
export const bundleSuiteSchema = simpleMigrationSuiteSchema;
export const analysisSchema = z.strictObject({
  summary: z.string().min(1).max(20000),
  changes: z.array(z.strictObject({ paths: z.array(pathSchema).min(1), reason: z.string().min(1) })).max(100),
  missing: z.array(z.string()).max(50),
});
export const deliverySchema = z.strictObject({
  summary: z.string().min(1).max(20000),
  services: z
    .array(
      z.strictObject({
        toolNames: z.array(z.string().min(1)).min(1),
        filePaths: z.array(pathSchema).min(1),
        start: z.array(z.string().min(1)).min(1).max(100),
        prepare: z.array(z.string()).max(100).optional(),
      }),
    )
    .max(20)
    .default([]),
});
export type BundleAnalysis = z.infer<typeof analysisSchema>;
export type BundleDelivery = z.infer<typeof deliverySchema>;
export type BundleCandidate = Omit<BundleSnapshot, 'files'> & {
  id: string;
  parentId: string | null;
  createdAt: string;
  summary: string;
  services: BundleDelivery['services'];
  diff: Array<{ path: string; kind: 'ADDED' | 'CHANGED' | 'REMOVED'; }>;
  checks: string[];
};
export type BundleAttempt = {
  id: string;
  kind: 'ANALYZE' | 'GENERATE' | 'REPAIR' | 'ACCEPT';
  key: string;
  requestDigest: string;
  baseCandidateId: string | null;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED';
  startedAt: string;
  finishedAt?: string;
  message: string;
  error?: string;
  runId?: string;
  requestId?: string;
  agentRunId?: string;
};
export type BundleVerdict = { passed: boolean; reason: string; };
export type BundleRun = {
  id: string;
  candidateId: string;
  candidateDigest: string;
  configuration: BundleConfiguration;
  configurationDigest: string;
  suite: z.infer<typeof bundleSuiteSchema>;
  suiteDigest: string;
  phase: 'development' | 'holdout';
  status: 'RUNNING' | 'PASSED' | 'FAILED' | 'INCOMPLETE' | 'CANCELLED';
  createdAt: string;
  finishedAt?: string;
  cases: Array<{ id: string; passed: boolean; reason: string; evidence?: RuntimeExecutionEvidence; }>;
  finalization?: unknown;
  runtimeSnapshot?: unknown;
};
export type BundleTask = {
  schemaVersion: 'finance.skill-migration.bundle.v1';
  id: string;
  name: string;
  goal: string;
  target: string;
  createdAt: string;
  source: Omit<BundleSnapshot, 'files'>;
  origin?: { kind: 'legacy-project'; projectId: string; assetId: string; selection: 'source' | 'candidate'; };
  requestId?: string;
  analysis?: BundleAnalysis;
  currentCandidateId: string | null;
  candidates: BundleCandidate[];
  configuration?: BundleConfiguration;
  suite?: z.infer<typeof bundleSuiteSchema>;
  attempts: BundleAttempt[];
  runs: BundleRun[];
};
export const createBundleSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  goal: z.string().trim().min(1).max(8000),
  target: z.string().trim().min(1).max(2000),
  sourceAssetIds: z.array(z.string().min(1)).min(1).max(10),
});
export const operationSchema = z.strictObject({
  key: z.string().min(1).max(100),
  baseCandidateId: z.string().nullable(),
  runId: z.string().optional(),
  phase: z.enum(['development', 'holdout']).default('development'),
});
export function bundleError(message: string, statusCode = 409): never {
  throw Object.assign(new Error(message), { statusCode });
}
export function validateFiles(files: BundleFiles) {
  const keys = Object.keys(files);
  if (!keys.length || keys.length > 1000) bundleError('整组文件数必须为 1–1000', 400);
  const seen = new Set<string>();
  let bytes = 0;
  for (const name of keys) {
    pathSchema.parse(name);
    const normalized = name.toLowerCase();
    if (seen.has(normalized)) bundleError('存在大小写冲突的路径', 400);
    seen.add(normalized);
    const raw = Buffer.from(files[name]!, 'base64');
    if (raw.toString('base64') !== files[name]) bundleError('文件内容编码无效', 400);
    bytes += raw.length;
  }
  if (bytes > 32 * 1024 * 1024) bundleError('整组解压内容超过 32 MB', 400);
}
export function filesDigest(files: BundleFiles) {
  const hash = createHash('sha256');
  for (const name of Object.keys(files).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    hash.update(name).update('\0').update(Buffer.from(files[name]!, 'base64')).update('\0');
  }
  return hash.digest('hex');
}
export function readText(files: BundleFiles, name: string) {
  const bytes = files[name];
  if (bytes === undefined) bundleError('缺少文件：' + name, 400);
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(bytes, 'base64'));
}
export function snapshot(files: BundleFiles, version: string, previous?: BundleSnapshot): BundleSnapshot {
  validateFiles(files);
  const entries = Object.keys(files)
    .filter((name) => /(^|\/)SKILL\.md$/.test(name))
    .sort();
  if (entries.length < 1 || entries.length > 10) bundleError('整体迁移需要 1–10 个独立 SKILL.md 入口', 400);
  const members = entries.map((skillFile, index) => {
    const content = readText(files, skillFile);
    const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s|$)/);
    const metadata = match ? parseYaml(match[1]!) : {};
    if (
      !metadata ||
      typeof metadata.name !== 'string' ||
      typeof metadata.description !== 'string' ||
      !metadata.name.trim() ||
      !metadata.description.trim()
    )
      bundleError(skillFile + ' 的 frontmatter 需要 name 和 description', 400);
    const root = skillFile.slice(0, -'SKILL.md'.length);
    if (entries.some((other) => other !== skillFile && other.startsWith(root)))
      bundleError('Skill 入口不能相互嵌套，请调整目录', 400);
    const memberFiles = Object.fromEntries(Object.entries(files).filter(([name]) => name.startsWith(root)));
    const digest = filesDigest(memberFiles),
      old = previous?.members.find((m) => m.skillFile === skillFile);
    return memberSchema.parse({
      id: old?.id ?? 'skill-' + (index + 1),
      skillId: metadata.name.trim(),
      skillFile,
      version: old?.artifactSha256 === digest ? old.version : version,
      artifactSha256: digest,
    });
  });
  if (new Set(members.map((m) => m.skillId.toLowerCase())).size !== members.length)
    bundleError('Skill 名称重复，请先明确各成员名称', 400);
  if (
    previous &&
    (members.length !== previous.members.length ||
      previous.members.some((m) => !members.some((next) => next.skillFile === m.skillFile)))
  )
    bundleError('整组候选必须保留全部已登记 Skill 入口');
  return { digest: filesDigest(files), members, files };
}
export function decodeBundleZip(buffer: Buffer): BundleFiles {
  if (!buffer.length || buffer.length > 8 * 1024 * 1024) bundleError('整组 ZIP 不得超过 8 MB', 400);
  let bytes = 0,
    count = 0;
  const seen = new Set<string>();
  const raw = unzipSync(buffer, {
    filter: (file) => {
      if (file.name.endsWith('/')) return false;
      pathSchema.parse(file.name);
      const name = file.name.toLowerCase();
      if (seen.has(name)) bundleError('ZIP 路径重复', 400);
      seen.add(name);
      bytes += file.originalSize;
      if (bytes > 32 * 1024 * 1024 || ++count > 1000) bundleError('ZIP 超过解压限制', 400);
      return true;
    },
  });
  const files = Object.fromEntries(
    Object.entries(raw).map(([name, content]) => [name, Buffer.from(content).toString('base64')]),
  );
  validateFiles(files);
  return files;
}
export function bundleZip(files: BundleFiles) {
  return Buffer.from(
    zipSync(
      Object.fromEntries(
        Object.entries(files).map(([name, content]) => [name, Buffer.from(content, 'base64')]),
      ),
    ),
  );
}
export function bundleDiff(before: BundleFiles, after: BundleFiles): BundleCandidate['diff'] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .flatMap((path) =>
      before[path] === after[path]
        ? []
        : [
          {
            path,
            kind:
              before[path] === undefined
                ? ('ADDED' as const)
                : after[path] === undefined
                  ? ('REMOVED' as const)
                  : ('CHANGED' as const),
          },
        ],
    );
}
export function currentCandidate(task: BundleTask) {
  return task.candidates.find((candidate) => candidate.id === task.currentCandidateId);
}
export function verifiedRun(task: BundleTask) {
  if (!task.configuration || !task.suite) return undefined;
  const latest = [...task.runs]
    .reverse()
    .find(
      (run) =>
        run.candidateId === task.currentCandidateId &&
        run.configurationDigest === canonicalSha256(task.configuration) &&
        run.suiteDigest === canonicalSha256(task.suite),
    );
  return latest?.status === 'PASSED' && (!task.suite.holdoutCases?.length || latest.phase === 'holdout')
    ? latest
    : undefined;
}
