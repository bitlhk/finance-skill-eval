import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { writeJsonAtomic } from '../src/service/file-store.js';

/** The next rename calls fail with these codes, in order; an empty queue means "let it through". */
const failures = vi.hoisted(() => ({ queue: [] as string[] }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      const code = failures.queue.shift();
      if (code) throw Object.assign(new Error(`${code}: rename failed`), { code });
      return actual.rename(from, to);
    },
  };
});

const dirs: string[] = [];
afterEach(async () => {
  failures.queue.length = 0;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const scratch = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'file-store-'));
  dirs.push(dir);
  return dir;
};

/**
 * Replacing a file while another handle has it open fails on Windows with EPERM. That is a reader
 * in the way, not a failed write -- and it used to surface as a failed migration run, because the
 * report endpoint polls these files while a run rewrites them.
 */
it('retries a rename that a concurrent reader is blocking, and still lands the write', async () => {
  const dir = await scratch();
  const target = path.join(dir, 'run.json');
  await writeFile(target, '{"status":"RUNNING"}\n');
  failures.queue.push('EPERM', 'EPERM');
  await writeJsonAtomic(target, { status: 'PASSED' });
  expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ status: 'PASSED' });
  expect(await readdir(dir)).toEqual(['run.json']);
});

it('gives up on an error that retrying cannot fix, and leaves no temp file behind', async () => {
  const dir = await scratch();
  failures.queue.push('EXDEV');
  await expect(writeJsonAtomic(path.join(dir, 'run.json'), { status: 'PASSED' })).rejects.toMatchObject({ code: 'EXDEV' });
  expect(await readdir(dir)).toEqual([]);
});
