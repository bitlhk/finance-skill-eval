import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export async function ensureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
}

/**
 * Readers poll these files while writers replace them. On Windows, replacing a file that another
 * handle has open fails with EPERM -- not a corrupt write, just a reader in the way -- so the
 * rename is retried briefly instead of surfacing as a failed run. The temp file is unique per
 * write, so a retry can never clobber another writer's file.
 */
const RENAME_RETRIES = 50;
const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await ensureDirectory(path.dirname(filePath));
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, filePath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!RETRYABLE.has(code) || attempt >= RENAME_RETRIES) {
        await rm(temporary, { force: true });
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
}

export async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

export async function listJsonFiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory))
      .filter(name => name.endsWith(".json"))
      .map(name => path.join(directory, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
