import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { zipSync } from "fflate";

async function pack(source, output) {
  const files = {};
  for (const name of await readdir(source, { recursive: true })) {
    const segments = name.split(/[\\/]/);
    if (segments.includes("__pycache__") || segments.some(segment => segment.startsWith(".venv")) || name.endsWith(".pyc")) continue;
    const absolute = path.join(source, name);
    const content = await readFile(absolute).catch(error => {
      if (error.code === "EISDIR") return null;
      throw error;
    });
    if (content) files[name.replaceAll("\\", "/")] = content;
  }
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, Buffer.from(zipSync(files)));
  return { output, files: Object.keys(files).sort() };
}

const root = path.resolve("acceptance/openjiuwen-portability");
const artifacts = path.resolve("artifacts");
const result = {
  source: await pack(path.join(root, "legacy-skill"), path.join(artifacts, "openjiuwen-portability-legacy-1.0.0.zip")),
  completed: await pack(path.join(root, "skill"), path.join(artifacts, "openjiuwen-portability-completed-2.0.0.zip")),
  scriptOnly: await pack(path.join(root, "script-only-skill"), path.join(artifacts, "script-only-acceptance-1.0.0.zip")),
  sharedMcp: await pack(path.join(root, "shared-mcp-skill"), path.join(artifacts, "shared-mcp-acceptance-1.0.0.zip")),
};
console.log(JSON.stringify(result));
