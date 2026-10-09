import { randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import { parse as parseYaml } from "yaml";
import { fingerprint } from "../contracts.js";
import type { SkillAssetRecord } from "../shared/contracts/skill-asset.js";
import { ensureDirectory, listJsonFiles, readJson, writeJsonAtomic } from "./file-store.js";
export type { SkillAssetRecord } from "../shared/contracts/skill-asset.js";

function safeArchivePath(name: string): string {
  const normalized = name.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe Skill archive path: ${name}`);
  }
  return normalized;
}
function parseFrontmatter(source: string): Record<string, unknown> {
  // Import legacy metadata without rewriting the immutable source bytes.
  const match = source.match(/^---[^\S\r\n]*\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*(?:\r?\n|$)/u)
    ?? source.match(/^(name:[^\n]*\n[\s\S]{0,8000}?)\r?\n---[^\S\r\n]*(?:\r?\n|$)/u);
  if (!match?.[1]) return {};
  const parsed = parseYaml(match[1]);
  return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export class SkillStore {
  private readonly assetsDirectory: string;
  private readonly recordsDirectory: string;

  constructor(dataDirectory: string) {
    this.assetsDirectory = path.join(dataDirectory, "skills", "assets");
    this.recordsDirectory = path.join(dataDirectory, "skills", "records");
  }

  async initialize(): Promise<void> {
    await Promise.all([
      ensureDirectory(this.assetsDirectory),
      ensureDirectory(this.recordsDirectory),
    ]);
  }

  async list(): Promise<SkillAssetRecord[]> {
    const records = await Promise.all(
      (await listJsonFiles(this.recordsDirectory)).map(file => readJson<SkillAssetRecord>(file)),
    );
    return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async get(assetId: string): Promise<SkillAssetRecord | null> {
    if (!/^[a-z0-9-]+$/u.test(assetId)) return null;
    try {
      return await readJson<SkillAssetRecord>(path.join(this.recordsDirectory, `${assetId}.json`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async readSource(assetId: string): Promise<string> {
    const record = await this.get(assetId);
    if (!record) throw new Error(`Unknown Skill asset: ${assetId}`);
    return readFile(path.join(this.assetsDirectory, record.assetId, record.skillFile), "utf8");
  }

  async readFiles(assetId: string): Promise<Record<string, string>> {
    const record = await this.get(assetId);
    if (!record) throw new Error(`Unknown Skill asset: ${assetId}`);
    const root = path.join(this.assetsDirectory, assetId, path.dirname(record.skillFile));
    const files: Record<string, string> = {};
    for (const relative of await readdir(root, { recursive: true })) {
      if (/\.(md|txt|yaml|yml|json)$/iu.test(relative)) {
        files[relative.replaceAll(path.sep, "/")] = await readFile(path.join(root, relative), "utf8");
      }
    }
    return files;
  }

  async readArchive(assetId: string): Promise<Record<string, Uint8Array>> {
    const record = await this.get(assetId);
    if (!record) throw new Error(`Unknown Skill asset: ${assetId}`);
    const root = path.join(this.assetsDirectory, assetId);
    const files: Record<string, Uint8Array> = {};
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Skill 包不能包含符号链接');
      if (!entry.isFile()) continue;
      const file = path.join(entry.parentPath, entry.name);
      files[path.relative(root, file).replaceAll(path.sep, '/')]=await readFile(file);
    }
    const entries=Object.entries(files).sort(([a],[b])=>a.localeCompare(b));
    const digest=fingerprint(entries.map(([name,content])=>({name,content:Buffer.from(content).toString('base64')})));
    if (entries.length!==record.fileCount || digest!==record.artifactSha256) throw new Error('Skill 快照摘要不一致');
    return files;
  }

  async uploadZip(buffer: Buffer, options: { migrationInput?: boolean; version?: string } = {}): Promise<SkillAssetRecord> {
    if (buffer.byteLength === 0 || buffer.byteLength > 8 * 1024 * 1024) {
      throw new Error("Skill ZIP 大小必须在 1 字节到 8 MB 之间");
    }
    let declaredBytes = 0, declaredCount = 0;
    const archive = unzipSync(buffer, { filter: file => {
      if (file.name.endsWith("/")) return false;
      safeArchivePath(file.name);
      declaredBytes += file.originalSize; declaredCount += 1;
      if (declaredBytes > 16 * 1024 * 1024 || declaredCount > 200) throw new Error("Skill ZIP 超过解压限制");
      return true;
    } });
    const files = Object.entries(archive);
    if (files.length === 0 || files.length > 200) {
      throw new Error("Skill ZIP 的文件数必须在 1 到 200 之间");
    }
    let uncompressedBytes = 0;
    const normalizedFiles = files.map(([name, content]) => {
      uncompressedBytes += content.byteLength;
      return [safeArchivePath(name), content] as const;
    });
    if (uncompressedBytes > 16 * 1024 * 1024) {
      throw new Error("解压后的 Skill 内容超过 16 MB");
    }
    const skillCandidates = normalizedFiles
      .map(([name]) => name)
      .filter(name => /(^|\/)skill\.md$/iu.test(name))
      .sort((left, right) => left.split("/").length - right.split("/").length);
    // Migration input is not required to sit under skill/: pick the shallowest
    // readable instruction file wherever the tree puts it.
    const migrationFallback = options.migrationInput
      ? normalizedFiles.map(([name])=>name).filter(name=>/\.(?:md|mdx|txt)$/iu.test(name))
        .sort((left,right)=>left.split('/').length-right.split('/').length||left.localeCompare(right))[0]
      : undefined;
    const skillFile = skillCandidates.find(name=>name==='skill/SKILL.md')??skillCandidates[0]??migrationFallback;
    if (!skillFile) throw new Error(options.migrationInput?'Migration ZIP needs a readable instruction file (.md/.mdx/.txt) anywhere in the archive':'Skill ZIP does not contain SKILL.md');
    if (skillCandidates.length > 1&&!options.migrationInput) throw new Error('Skill ZIP 根目录有多个 Skill 入口：不支持一个包里放多个 Skill，请分别上传');
    const sourceBytes = normalizedFiles.find(([name]) => name === skillFile)?.[1];
    if (!sourceBytes) throw new Error("无法从压缩包里读出 SKILL.md");
    const source = Buffer.from(sourceBytes).toString("utf8");
    if (!source.trim()&&!options.migrationInput) throw new Error("SKILL.md 是空的");
    const metadata = parseFrontmatter(source);
    const skillId = asText(metadata.name) ?? `uploaded-skill-${randomUUID().slice(0, 8)}`;
    const version = asText(options.version) ?? asText(metadata.version) ?? "0.0.0-upload";
    normalizedFiles.sort(([a], [b]) => a.localeCompare(b));
    if (new Set(normalizedFiles.map(([name]) => name)).size !== normalizedFiles.length) throw new Error("Duplicate archive paths");
    const digest = fingerprint(normalizedFiles.map(([name, content]) => ({
      name,
      content: Buffer.from(content).toString("base64"),
    })));
    const assetId = `${skillId.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 48) || "skill"}-${digest.slice(0, 12)}`;
    const target = path.join(this.assetsDirectory, assetId);
    const existing = await this.get(assetId);
    if (existing) return existing;
    for (const [name, content] of normalizedFiles) {
      const filePath = path.join(target, name);
      await ensureDirectory(path.dirname(filePath));
      await writeFile(filePath, content, { mode: 0o600 });
    }
    const now = new Date().toISOString();
    const record: SkillAssetRecord = {
      schemaVersion: "finance.skill-eval.skill-asset.v1",
      assetId,
      skillId,
      version,
      displayName: asText(metadata.displayName) ?? asText(metadata.name) ?? skillId,
      description: asText(metadata.description) ?? "用户上传的 Skill 候选资产",
      sourceType: "uploaded",
      artifactSha256: digest,
      skillFile,
      fileCount: files.length,
      createdAt: now,
    };
    await writeJsonAtomic(path.join(this.recordsDirectory, `${assetId}.json`), record);
    return record;
  }

  async uploadMigrationZip(buffer: Buffer): Promise<SkillAssetRecord> {
    // Import stays thin: unzip, digest, safety limits. It does not judge the
    // directory layout -- real source projects do not follow a fixed one, and
    // A2 is an agent that can inspect the tree itself. Credential files are not
    // rejected here; the export path is the gate that matters.
    if (buffer.byteLength === 0 || buffer.byteLength > 8 * 1024 * 1024) {
      throw new Error("迁移 ZIP 大小必须在 1 字节到 8 MB 之间");
    }
    return this.uploadZip(buffer, { migrationInput: true });
  }
}
