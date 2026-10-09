import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {zipSync} from 'fflate';

const destination = process.argv[2];
if (!destination) throw new Error('Usage: node examples/fact-check-demo/package.mjs OUTPUT.zip');
const source = await readFile(new URL('./SKILL.md', import.meta.url));
const archive = Buffer.from(zipSync({
  'SKILL.md': [source, {mtime: new Date('2020-01-01T00:00:00Z')}],
}, {level: 6}));
// Refuse overwriting an existing archive or following an existing output symlink.
await writeFile(destination, archive, {flag: 'wx', mode: 0o600});
console.log(JSON.stringify({path: resolve(destination), files: ['SKILL.md'],
  sha256: createHash('sha256').update(archive).digest('hex')}));
