import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import { parse as parseYaml } from "yaml";
import { fingerprint } from "../contracts.js";
import { ensureDirectory, listJsonFiles, readJson, writeJsonAtomic } from "./file-store.js";

export type SkillAssetRecord = {
  schemaVersion: "finance.skill-eval.skill-asset.v1";
  assetId: string;
  skillId: string;
  version: string;
  displayName: string;
  description: string;
  sourceType: "uploaded";
  artifactSha256: string;
  skillFile: string;
  fileCount: number;
  createdAt: string;
};

function safeArchivePath(name: string): string {
  const normalized = name.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe Skill archive path: ${name}`);
  }
  return normalized;
}
function parseFrontmatter(source: string): Record<string, unknown> {
  const match = source.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/u);
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

  async uploadZip(buffer: Buffer): Promise<SkillAssetRecord> {
    if (buffer.byteLength === 0 || buffer.byteLength > 8 * 1024 * 1024) {
      throw new Error("Skill ZIP must be between 1 byte and 8 MB");
    }
    const archive = unzipSync(buffer, { filter: file => !file.name.endsWith("/") });
    const files = Object.entries(archive);
    if (files.length === 0 || files.length > 200) {
      throw new Error("Skill ZIP must contain between 1 and 200 files");
    }
    let uncompressedBytes = 0;
    const normalizedFiles = files.map(([name, content]) => {
      uncompressedBytes += content.byteLength;
      return [safeArchivePath(name), content] as const;
    });
    if (uncompressedBytes > 16 * 1024 * 1024) {
      throw new Error("Uncompressed Skill content exceeds 16 MB");
    }
    const skillCandidates = normalizedFiles
      .map(([name]) => name)
      .filter(name => name === "SKILL.md" || name.endsWith("/SKILL.md"))
      .sort((left, right) => left.split("/").length - right.split("/").length);
    const skillFile = skillCandidates[0];
    if (!skillFile) throw new Error("Skill ZIP does not contain SKILL.md");
    const sourceBytes = normalizedFiles.find(([name]) => name === skillFile)?.[1];
    if (!sourceBytes) throw new Error("Unable to read SKILL.md from archive");
    const source = Buffer.from(sourceBytes).toString("utf8");
    if (!source.trim()) throw new Error("SKILL.md is empty");
    const metadata = parseFrontmatter(source);
    const skillId = asText(metadata.name) ?? `uploaded-skill-${randomUUID().slice(0, 8)}`;
    const version = asText(metadata.version) ?? "0.0.0-upload";
    const digest = fingerprint(normalizedFiles.map(([name, content]) => ({
      name,
      content: Buffer.from(content).toString("base64"),
    })));
    const assetId = `${skillId.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 48) || "skill"}-${digest.slice(0, 12)}`;
    const target = path.join(this.assetsDirectory, assetId);
    await rm(target, { recursive: true, force: true });
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
}
