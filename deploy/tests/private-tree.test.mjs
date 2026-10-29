import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, link, lstat, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { privateTree } from '../lib/private-tree.mjs';

test('detaches package hard links without changing the shared store', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'finance-private-'));
  try {
    await mkdir(path.join(dir, 'release'));
    const store = path.join(dir, 'store'), file = path.join(dir, 'release', 'package');
    await writeFile(store, 'original');
    await link(store, file);
    assert.equal(await privateTree(path.dirname(file)), 1);
    assert.equal((await lstat(file)).nlink, 1);
    await writeFile(file, 'private');
    assert.equal(await readFile(store, 'utf8'), 'original');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('refuses external junctions before detaching any files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'finance-private-'));
  try {
    await mkdir(path.join(dir, 'release')); await mkdir(path.join(dir, 'outside'));
    await writeFile(path.join(dir, 'store'), 'original');
    await link(path.join(dir, 'store'), path.join(dir, 'release', 'a'));
    await symlink(path.join(dir, 'outside'), path.join(dir, 'release', 'z'), 'junction');
    await assert.rejects(privateTree(path.join(dir, 'release')), /LINK_OUTSIDE_INSTALLATION/);
    assert.equal((await lstat(path.join(dir, 'store'))).nlink, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
