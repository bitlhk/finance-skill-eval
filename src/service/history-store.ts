import path from 'node:path';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { environmentRecordSchema } from '../shared/contracts/environment.js';
import type { HistoryDetail, HistoryKind, HistoryOrigin, HistorySnapshot, HistorySummary } from '../shared/contracts/history.js';

const origins: HistoryOrigin[] = ['bundles', 'migrations', 'tasks', 'environments'];
const idPattern = /^[a-z0-9][a-z0-9-]{0,119}$/;
const revisionPattern = /^(source|candidate-[a-z0-9-]+)$/;
const directories = { bundles: 'migration-bundles/tasks', migrations: 'migrations', tasks: 'migration-tasks/tasks', environments: 'environments' };
export const historyTaskReason = '此任务采用旧版任务或执行协议，当前版本无法安全恢复执行；历史分析、候选和验收结果仅供查阅，不代表已通过当前版本验收。';
const nextTaskStep = '可查看或下载历史留档，取出原始 Skill 后新建迁移任务，并在当前环境重新验收。';
function fail(message: string, statusCode = 400): never { throw Object.assign(new Error(message), { statusCode }); }
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown) => typeof value === 'string' ? value : null;

/** Read-only projections: original records, snapshots and proof bytes are never migrated or saved. */
export class HistoryStore {
  constructor(private root: string) {}
  private check(origin: string, id: string): asserts origin is HistoryOrigin {
    if (!origins.includes(origin as HistoryOrigin) || !idPattern.test(id)) fail('历史记录标识无效');
  }
  private recordFile(origin: HistoryOrigin, id: string) { return path.join(this.root, directories[origin], id + '.json'); }
  private async safePath(file: string) {
    // No symlink/junction may redirect a historical record or snapshot to another location.
    const base = await realpath(this.root);
    const expected = path.resolve(base, path.relative(this.root, file));
    const actual = await realpath(file);
    const normalize = (p: string) => process.platform === 'win32' ? p.toLowerCase() : p;
    if (normalize(actual) !== normalize(expected)) fail('历史文件路径已重定向，无法安全读取', 409);
    return actual;
  }
  private async bytes(file: string): Promise<Buffer> {
    const actual = await this.safePath(file);
    const info = await stat(actual);
    if (!info.isFile() || info.size > 64 * 1024 * 1024) fail('历史文件过大或不是普通文件，无法在线读取', 409);
    return readFile(actual);
  }
  private async read(origin: HistoryOrigin, id: string) {
    const bytes = await this.bytes(this.recordFile(origin, id));
    try {
      const record = object(JSON.parse(bytes.toString('utf8')));
      const storedId = record?.id ?? record?.environmentId;
      return { record, issue: !record ? '记录不是有效对象，可下载原始留档排查。'
        : storedId && storedId !== id ? '记录内标识与文件名不一致，按原文件留档，不能继续执行。' : undefined };
    } catch { return { record: null, issue: '记录 JSON 已损坏，可下载原始留档排查。' }; }
  }
  private isHistory(origin: HistoryOrigin, record: Record<string, unknown> | null) {
    if (origin === 'tasks') return record?.schemaVersion !== 'finance.skill-migration.task.v1';
    if (origin === 'environments') return !environmentRecordSchema.safeParse(record).success;
    return true;
  }
  private summary(origin: HistoryOrigin, id: string, record: Record<string, unknown> | null, issue?: string): HistorySummary {
    const protocol = object(object(record?.delivery)?.evalConformance)?.instanceSchemaVersion;
    const environment = origin === 'environments';
    return { origin, id, name: text(record?.name) ?? id, createdAt: text(record?.createdAt),
      schemaVersion: text(record?.schemaVersion) ?? text(protocol) ?? text(record?.type) ?? '未知格式', readOnly: true,
      reason: issue ? '记录不完整或格式不兼容，无法执行或修改；原始文件仍保留。' : environment
        ? (protocol ? `该环境的验收记录使用旧协议 ${String(protocol)}，不能证明其符合当前 Runtime 协议。` : '该环境登记格式已停用或不符合当前协议，不能作为可执行环境使用。')
        : historyTaskReason,
      nextStep: environment ? '保留此登记作历史参考；升级 Runtime 后重新登记并完成当前版本预检或交付验收。' : nextTaskStep,
      ...(issue ? { issue } : {}) };
  }
  async list(kind: HistoryKind): Promise<HistorySummary[]> {
    const result: HistorySummary[] = [];
    for (const origin of kind === 'environments' ? ['environments'] as const : ['bundles', 'migrations', 'tasks'] as const) {
      let names: string[];
      try { names = await readdir(await this.safePath(path.join(this.root, directories[origin]))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      for (const name of names.filter(name => name.endsWith('.json'))) {
        const id = name.slice(0, -5);
        if (!idPattern.test(id)) continue;
        try {
          const { record, issue } = await this.read(origin, id);
          if (this.isHistory(origin, record)) result.push(this.summary(origin, id, record, issue));
        } catch { result.push(this.summary(origin, id, null, '历史文件无法读取，请检查文件权限、大小和路径。')); }
      }
    }
    return result.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || a.id.localeCompare(b.id));
  }
  private snapshotDirectory(origin: HistoryOrigin, id: string) {
    if (origin !== 'bundles' && origin !== 'tasks') return null;
    return path.join(this.root, origin === 'bundles' ? 'migration-bundles' : 'migration-tasks', 'snapshots', id);
  }
  async get(originInput: string, id: string): Promise<HistoryDetail> {
    this.check(originInput, id);
    let loaded;
    try { loaded = await this.read(originInput, id); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('历史记录不存在', 404); throw error; }
    const { record, issue } = loaded;
    if (!this.isHistory(originInput, record)) fail('此记录属于当前版本，请使用当前任务或环境入口', 409);
    const directory = this.snapshotDirectory(originInput, id);
    let snapshots: HistoryDetail['snapshots'] = [], snapshotIssue: string | undefined;
    if (directory) {
      try {
        snapshots = (await readdir(await this.safePath(directory))).filter(name => name.endsWith('.json') && revisionPattern.test(name.slice(0, -5)))
          .map(name => ({ revision: name.slice(0, -5), label: name === 'source.json' ? '原始 Skill' : name.slice(0, -5) }))
          .sort((a, b) => a.revision === 'source' ? -1 : b.revision === 'source' ? 1 : a.revision.localeCompare(b.revision));
        if (!snapshots.length) snapshotIssue = '未找到文件快照，仍可查看任务记录。';
        else {
          const expected = ['source', ...(Array.isArray(record?.candidates) ? record.candidates.map(value => text(object(value)?.id)).filter((value): value is string => !!value && revisionPattern.test(value)) : [])];
          const missing = expected.filter(revision => !snapshots.some(item => item.revision === revision));
          if (missing.length) snapshotIssue = '以下文件快照缺失，不能还原该版本文件：' + missing.join('、');
        }
      } catch { snapshotIssue = '文件快照缺失或不可读取，仍可查看任务记录。'; }
    }
    return { ...this.summary(originInput, id, record, issue), record, snapshots, ...(snapshotIssue ? { snapshotIssue } : {}) };
  }
  private async snapshotData(origin: string, id: string, revision: string) {
    const detail = await this.get(origin, id);
    if (!revisionPattern.test(revision) || !detail.snapshots.some(item => item.revision === revision)) fail('历史快照不存在', 404);
    const directory = this.snapshotDirectory(detail.origin, id)!;
    try {
      const value = object(JSON.parse((await this.bytes(path.join(directory, revision + '.json'))).toString('utf8')));
      const files = object(value?.files);
      if (!files) fail('历史快照缺少文件内容', 409);
      return { files, digest: text(value?.digest) };
    } catch (error) { if ((error as {statusCode?: number}).statusCode) throw error; fail('历史快照损坏或无法读取，可下载留档排查', 409); }
  }
  async snapshot(origin: string, id: string, revision: string): Promise<HistorySnapshot> {
    const value = await this.snapshotData(origin, id, revision);
    return { revision, digest: value.digest, files: Object.keys(value.files).sort() };
  }
  async file(origin: string, id: string, revision: string, name: string) {
    const value = await this.snapshotData(origin, id, revision);
    if (!Object.hasOwn(value.files, name) || typeof value.files[name] !== 'string') fail('历史文件不存在', 404);
    const bytes = Buffer.from(value.files[name], 'base64');
    if (bytes.toString('base64') !== value.files[name]) fail('历史文件编码无效', 409);
    if (bytes.length > 1024 * 1024) return { path: name, content: '文件超过在线预览上限，请下载历史留档查看。' };
    try { return { path: name, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }; }
    catch { return { path: name, content: '此文件为二进制，请下载历史留档查看。' }; }
  }
  async archive(origin: string, id: string) {
    const detail = await this.get(origin, id);
    const files: Record<string, Uint8Array> = { 'record.json': await this.bytes(this.recordFile(detail.origin, id)) };
    const issues: string[] = [];
    let total = files['record.json']!.length;
    for (const { revision } of detail.snapshots) {
      let bytes: Buffer;
      try { bytes = await this.bytes(path.join(this.snapshotDirectory(detail.origin, id)!, revision + '.json')); }
      catch { issues.push(revision + ' 无法读取，未包含在留档中'); continue; }
      total += bytes.length;
      if (total > 128 * 1024 * 1024) fail('历史留档超过在线下载上限，请联系维护者从数据备份获取', 409);
      files['snapshots/' + revision + '.json'] = bytes;
    }
    files['history-manifest.json'] = Buffer.from(JSON.stringify({ readOnly: true, reason: detail.reason, nextStep: detail.nextStep,
      issue: detail.issue, snapshotIssue: detail.snapshotIssue, issues,
      files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')])) }, null, 2));
    return Buffer.from(zipSync(files));
  }
  async blockedTask(id: string): Promise<HistorySummary | null> {
    if (!idPattern.test(id)) return null;
    try {
      const current = await this.read('tasks', id);
      if (!this.isHistory('tasks', current.record)) return null;
      return this.summary('tasks', id, current.record, current.issue);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try { const data = await this.read('bundles', id); return this.summary('bundles', id, data.record, data.issue); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async blockedEnvironment(id: string): Promise<HistorySummary | null> {
    if (!idPattern.test(id)) return null;
    try { const data = await this.read('environments', id); return this.isHistory('environments', data.record) ? this.summary('environments', id, data.record, data.issue) : null; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
}
