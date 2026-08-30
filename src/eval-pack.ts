import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  evalCaseSchema,
  evalPackFileSchema,
  fingerprint,
  judgeProfileSchema,
  type EvalPack,
} from "./contracts.js";

function resolveInside(baseDir: string, relativePath: string): string {
  const resolved = path.resolve(baseDir, relativePath);
  const relative = path.relative(baseDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Eval Pack path escapes its directory: ${relativePath}`);
  }
  return resolved;
}

async function readYaml(filePath: string): Promise<unknown> {
  return parseYaml(await readFile(filePath, "utf8"));
}

export async function loadEvalPack(filePath: string): Promise<EvalPack> {
  const sourceFile = path.resolve(filePath);
  const baseDir = path.dirname(sourceFile);
  const packFile = evalPackFileSchema.parse(await readYaml(sourceFile));
  const judgeProfile = judgeProfileSchema.parse(
    await readYaml(resolveInside(baseDir, packFile.judgeProfileFile)),
  );
  const cases = await Promise.all(
    packFile.caseFiles.map(async caseFile => evalCaseSchema.parse(
      await readYaml(resolveInside(baseDir, caseFile)),
    )),
  );
  const caseIds = new Set<string>();
  for (const evalCase of cases) {
    if (caseIds.has(evalCase.caseId)) {
      throw new Error(`Duplicate caseId in Eval Pack: ${evalCase.caseId}`);
    }
    caseIds.add(evalCase.caseId);
  }
  return {
    ...packFile,
    sourceFile,
    cases,
    judgeProfile,
    packFingerprint: fingerprint({
      pack: packFile,
      cases,
      judgeProfile,
    }),
  };
}
