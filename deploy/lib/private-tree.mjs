import { lstat, readdir, realpath, copyFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// ACLs belong to the file, including all its hard links. Detach package-store
// links before changing permissions, and reject junctions outside the install.
export async function privateTree(directory, boundary = directory) {
  const root = await realpath(boundary);
  const files = [];
  const inside = value => {
    const relative = path.relative(root, value);
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  };
  if (!inside(await realpath(directory))) throw new Error('TREE_OUTSIDE_INSTALLATION');
  async function visit(file) {
    const info = await lstat(file);
    if (info.isSymbolicLink()) {
      if (!inside(await realpath(file))) throw new Error('LINK_OUTSIDE_INSTALLATION');
    } else if (info.isDirectory()) {
      for (const name of await readdir(file)) await visit(path.join(file, name));
    } else if (info.isFile() && info.nlink > 1) files.push(file);
  }
  await visit(directory);
  for (const file of files) {
    const temporary = file + '.private-' + randomUUID();
    try { await copyFile(file, temporary); await rename(temporary, file); }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  return files.length;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log('Shared dependency files detached: ' + await privateTree(process.argv[2], process.argv[3])); }
  catch { console.error('Private tree preparation failed; check file links and permissions.'); process.exitCode = 1; }
}
