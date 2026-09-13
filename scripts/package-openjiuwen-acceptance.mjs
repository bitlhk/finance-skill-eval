import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { zipSync } from "fflate";

const root = path.resolve("acceptance/openjiuwen-portability/skill");
const output = path.resolve(process.argv[2] ?? "artifacts/openjiuwen-portability-acceptance.zip");
const files = {};

for (const name of await readdir(root, { recursive: true })) {
  const segments = name.split(/[\\/]/);
  if (
    segments.includes("__pycache__") ||
    segments.some(segment => segment === ".venv" || segment.startsWith(".venv-")) ||
    name.endsWith(".pyc")
  ) continue;
  const absolute = path.join(root, name);
  const content = await readFile(absolute).catch(error => {
    if (error.code === "EISDIR") return null;
    throw error;
  });
  if (content) files[name.replaceAll("\\", "/")] = content;
}

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, Buffer.from(zipSync(files)));
console.log(JSON.stringify({ output, files: Object.keys(files).sort() }));
