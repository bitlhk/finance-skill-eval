import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { unzipSync } from 'fflate';
import { SkillStore } from '../src/service/skill-store.js';
import { BundleMigrationService } from '../src/migration/bundle/bundle-service.js';
import {
  bundleZip,
  snapshot,
  decodeBundleZip,
  filesDigest,
  type BundleFiles,
} from '../src/migration/bundle/bundle-model.js';
import type {
  BundleAgent,
  BundleAgentInput,
  BundleRuntimeFactory,
  BundleJudge,
} from '../src/migration/bundle/bundle-ports.js';
import { registerBundleMigrationRoutes } from '../src/interfaces/http/bundle-migration-routes.js';

const roots: string[] = [],
  services: BundleMigrationService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const encoded = (text: string) => Buffer.from(text).toString('base64');
const files: BundleFiles = {
  'skills/budget/SKILL.md': encoded(
    '---\nname: budget\ndescription: Budget query\n---\nReturn amount in cents.',
  ),
  'skills/rules/SKILL.md': encoded(
    '---\nname: rules\ndescription: Compliance\n---\nInterpret amount as yuan.',
  ),
  'skills/report/SKILL.md': encoded('---\nname: report\ndescription: Report\n---\nExplain evidence.'),
  'shared/rules.json': encoded('{"limit":8000}'),
  'shared/图例.bin': Buffer.from([0, 255, 128]).toString('base64'),
};
const suite = {
  name: 'Combined task',
  cases: [
    {
      id: 'over-budget',
      input: 'Check 8000 yuan against 5000 yuan budget.',
      criteria: ['Must reject over budget.'],
    },
  ],
  holdoutCases: [{ id: 'secret-holdout', input: 'HIDDEN_CASE', criteria: ['HIDDEN_CRITERION'] }],
};
const config = { environmentId: 'env-test', modelId: 'execution', timeoutMs: 10000 };
async function fixture(customAgent?: BundleAgent, customRuntime?: BundleRuntimeFactory, sourceFiles: BundleFiles = files, customJudge?:BundleJudge) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bundle-test-'));
  roots.push(root);
  const skills = new SkillStore(root);
  await skills.initialize();
  const seen: BundleAgentInput[] = [];
  const agent: BundleAgent =
    customAgent ??
    (async (input) => {
      seen.push(input);
      if (input.mode === 'ANALYZE')
        return {
          status: 'PRODUCED',
          analysis: {
            summary: 'Fix shared units',
            changes: [{ paths: ['skills/budget/SKILL.md', 'skills/rules/SKILL.md'], reason: 'Unify units' }],
            missing: [],
          },
        };
      const changed = { ...input.base.files };
      if (input.mode === 'REPAIR') {
        changed['skills/budget/SKILL.md'] = encoded(
          Buffer.from(changed['skills/budget/SKILL.md']!, 'base64').toString().replace('cents', 'yuan'),
        );
        changed['skills/rules/SKILL.md'] = encoded(
          Buffer.from(changed['skills/rules/SKILL.md']!, 'base64').toString() + ' Validate explicit unit.',
        );
      }
      return {
        status: 'PRODUCED',
        files: changed,
        delivery: {
          summary: input.mode === 'REPAIR' ? 'Updated two members' : 'Initial candidate',
          services: [],
        },
      };
    });
  const cleanup = vi.fn(async () => {}),
    launches: string[] = [],
    environment = { runtime: 'test' };
  const runtime: BundleRuntimeFactory =
    customRuntime ??
    (async ({ snapshot: bundle }) => ({
      model: { providerId: 'fixture', modelId: 'execution', parameters: {} },
      environmentSnapshot: structuredClone(environment),
      runtime: {
        adapterId: 'bundle-fixture',
        prepare: async () => {
          launches.push(bundle.digest);
        },
        cleanup,
        execute: async (request) => ({
          runId: request.runId,
          caseId: request.evalCase.caseId,
          side: 'right',
          modelId: 'execution',
          skillVersion: 'frozen',
          status: 'completed',
          output: Buffer.from(bundle.files['skills/budget/SKILL.md']!, 'base64').toString().includes('cents')
            ? 'ACCEPT'
            : 'REJECT',
          elapsedMs: 1,
          toolCalls: [],
          loadedSkills: bundle.members.map((m) => ({ skillId: m.skillId, version: m.version })),
          usage: null,
          runtimeIdentityVerified: true,
          streamCompleted: true,
          error: null,
          metadata: { contentDigest: bundle.digest, loadedSkillMembers: bundle.members },
        }),
      },
    }));
  const service = new BundleMigrationService(root, skills, agent, runtime, customJudge ?? (async ({ evidence }) => ({
    passed: evidence.output === 'REJECT',
    reason: 'Observed ' + evidence.output,
  })));
  services.push(service);
  await service.initialize();
  const task = await service.upload(
    { name: 'Procurement', goal: 'Review budget with all Skills', target: 'openjiuwen' },
    bundleZip(sourceFiles),
  );
  async function start(
    kind: 'ANALYZE' | 'GENERATE' | 'REPAIR' | 'ACCEPT',
    extra: Record<string, unknown> = {},
  ) {
    const latest = await service.get(task.id);
    await service.start(task.id, kind, {
      key: randomUUID(),
      baseCandidateId: latest.currentCandidateId,
      ...extra,
    });
    await vi.waitFor(async () =>
      expect((await service.get(task.id)).attempts.at(-1)?.status).not.toBe('RUNNING'),
    );
    return service.get(task.id);
  }
  return { root, skills, service, task, start, seen, cleanup, launches, environment };
}

it('retains completed execution evidence and blocks candidate repair when Judge fails',async()=>{
  const f=await fixture(undefined,undefined,files,async()=>{throw new Error('Judge response is invalid')});
  await f.start('ANALYZE');await f.start('GENERATE');
  await f.service.configure(f.task.id,config);await f.service.saveSuite(f.task.id,suite);
  const task=await f.start('ACCEPT');
  expect(task.runs[0]!.status).toBe('INCOMPLETE');
  expect(task.runs[0]!.cases[0]!.failureStage).toBe('JUDGE');
  expect(task.runs[0]!.cases[0]!.evidence?.status).toBe('completed');
  expect(f.cleanup).toHaveBeenCalled();
  await expect(f.service.export(task.id,true)).rejects.toThrow();
  await expect(f.service.start(task.id,'REPAIR',{key:randomUUID(),baseCandidateId:task.currentCandidateId,runId:task.runs[0]!.id})).rejects.toThrow('评审服务');
});

it('migrates the whole workspace, repairs two members, freezes history and exports only current verified inputs', async () => {
  const f = await fixture();
  await f.start('ANALYZE');
  let task = await f.start('GENERATE');
  expect(task.candidates).toHaveLength(1);
  await f.service.configure(task.id, config);
  await f.service.saveSuite(task.id, suite);
  task = await f.start('ACCEPT');
  expect(task.runs[0]!.status).toBe('FAILED');
  await expect(f.service.export(task.id, true)).rejects.toThrow('尚未通过');
  const first = await f.service.readSnapshot(task.id, task.currentCandidateId);
  task = await f.start('REPAIR', { runId: task.runs[0]!.id });
  expect(task.candidates[1]!.diff.map((d) => d.path)).toEqual([
    'skills/budget/SKILL.md',
    'skills/rules/SKILL.md',
  ]);
  expect(task.candidates[1]!.members.find((m) => m.skillId === 'report')).toEqual(
    task.candidates[0]!.members.find((m) => m.skillId === 'report'),
  );
  expect(await f.service.readSnapshot(task.id, task.candidates[0]!.id)).toEqual(first);
  expect(JSON.stringify(f.seen)).not.toContain('HIDDEN_CASE');
  expect(JSON.stringify(f.seen)).not.toContain('HIDDEN_CRITERION');
  expect(Object.keys(f.seen.at(-1)!.base.files)).toContain('shared/图例.bin');
  task = await f.start('ACCEPT');
  expect(task.runs[1]!.status).toBe('PASSED');
  await expect(f.service.export(task.id, true)).rejects.toThrow('尚未通过'); // holdout still required
  task = await f.start('ACCEPT', { phase: 'holdout' });
  expect(task.runs[2]!.status).toBe('PASSED');
  const archive = unzipSync(await f.service.export(task.id, true));
  expect(Buffer.from(archive['package/shared/图例.bin']!)).toEqual(Buffer.from([0, 255, 128]));
  expect(JSON.parse(Buffer.from(archive['migration/manifest.json']!).toString()).candidate.id).toBe(
    task.currentCandidateId,
  );
  f.environment.runtime = 'updated';
  await expect(f.service.export(task.id, true)).rejects.toThrow('运行环境已变化');
  const unverified = unzipSync(await f.service.export(task.id));
  expect(JSON.parse(Buffer.from(unverified['migration/manifest.json']!).toString()).verified).toBe(false);
  await f.service.configure(task.id, { ...config, modelId: 'changed' });
  await expect(f.service.export(task.id, true)).rejects.toThrow('尚未通过');
  expect(f.cleanup).toHaveBeenCalledTimes(3);
  expect(f.launches).toHaveLength(3);
});

it('does not publish a partial candidate or alter the source when a member is removed', async () => {
  const f = await fixture(async (input) =>
    input.mode === 'ANALYZE'
      ? { status: 'PRODUCED', analysis: { summary: 'Analyze', changes: [], missing: [] } }
      : {
          status: 'PRODUCED',
          delivery: { summary: 'Invalid', services: [] },
          files: Object.fromEntries(
            Object.entries(input.base.files).filter(([name]) => !name.includes('rules/SKILL.md')),
          ),
        },
  );
  await f.start('ANALYZE');
  const task = await f.start('GENERATE');
  expect(task.attempts.at(-1)?.status).toBe('FAILED');
  expect(task.candidates).toHaveLength(0);
  expect((await f.service.readSnapshot(task.id, null)).files).toEqual(files);
});

it('deduplicates operation retries, cancels agent work, and rejects stale candidate commands', async () => {
  let release: () => void = () => {};
  const f = await fixture(async (input) => {
    await new Promise<void>((resolve, reject) => {
      release = resolve;
      input.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    });
    return { status: 'PRODUCED', analysis: { summary: 'Done', changes: [], missing: [] } };
  });
  const input = { key: randomUUID(), baseCandidateId: null };
  await f.service.start(f.task.id, 'ANALYZE', input);
  await f.service.start(f.task.id, 'ANALYZE', input);
  expect((await f.service.get(f.task.id)).attempts).toHaveLength(1);
  await expect(f.service.start(f.task.id, 'GENERATE', input)).rejects.toThrow('其他操作');
  await f.service.cancel(f.task.id);
  release();
  expect((await f.service.get(f.task.id)).attempts[0]!.status).toBe('CANCELLED');
  await expect(
    f.service.start(f.task.id, 'ANALYZE', { key: randomUUID(), baseCandidateId: 'old' }),
  ).rejects.toThrow('候选已变化');
});

it('does not offer holdout evidence to repair', async () => {
  const f = await fixture();
  await f.start('ANALYZE');
  await f.start('GENERATE');
  await f.service.configure(f.task.id, config);
  await f.service.saveSuite(f.task.id, suite);
  const task = await f.start('ACCEPT', { phase: 'holdout' });
  await expect(
    f.service.start(task.id, 'REPAIR', {
      key: randomUUID(),
      baseCandidateId: task.currentCandidateId,
      runId: task.runs[0]!.id,
    }),
  ).rejects.toThrow('留出');
});

it('recovers interrupted operations without promoting incomplete runs', async () => {
  const f = await fixture();
  await f.start('ANALYZE');
  await f.start('GENERATE');
  await f.service.configure(f.task.id, config);
  await f.service.saveSuite(f.task.id, suite);
  const task = await f.start('ACCEPT');
  task.attempts.at(-1)!.status = 'RUNNING';
  task.runs[0]!.status = 'RUNNING';
  await writeFile(path.join(f.root, 'migration-tasks', 'tasks', task.id + '.json'), JSON.stringify(task));
  await f.service.initialize();
  const restored = await f.service.get(task.id);
  expect(restored.attempts.at(-1)?.status).toBe('INTERRUPTED');
  expect(restored.runs[0]!.status).toBe('INCOMPLETE');
  await expect(f.service.export(task.id, true)).rejects.toThrow('尚未通过');
});

it('rejects path traversal, case collisions, duplicate Skill names and nested entries', () => {
  expect(() => snapshot({ ...files, '../outside': encoded('bad') }, '1')).toThrow();
  expect(() => snapshot({ ...files, 'SHARED/RULES.JSON': encoded('bad') }, '1')).toThrow('大小写');
  expect(() =>
    snapshot({ ...files, 'skills/another/SKILL.md': files['skills/budget/SKILL.md']! }, '1'),
  ).toThrow('名称重复');
  expect(() =>
    snapshot(
      { ...files, 'skills/budget/nested/SKILL.md': encoded('---\nname: inner\ndescription: inner\n---\n') },
      '1',
    ),
  ).toThrow('嵌套');
  expect(decodeBundleZip(bundleZip(files))).toEqual(files);
  expect(filesDigest(files)).toBe(filesDigest({ ...files }));
});

it('protects bundle APIs in public workspaces and exposes async operations inside private ones', async () => {
  const f = await fixture(),
    app = Fastify();
  registerBundleMigrationRoutes(app, f.service, false);
  expect((await app.inject('/api/migration-tasks')).statusCode).toBe(403);
  expect((await app.inject('/api/migration-tasks')).statusCode).toBe(403);
  expect((await app.inject({method:'POST',url:'/api/migration-tasks/from-legacy/migration-a',payload:{}})).statusCode).toBe(403);
  await app.close();
  const privateApp = Fastify();
  registerBundleMigrationRoutes(privateApp, f.service, true);
  expect((await privateApp.inject('/api/migration-tasks/' + f.task.id)).json().source.members).toHaveLength(
    3,
  );
  const response = await privateApp.inject({
    method: 'POST',
    url: '/api/migration-tasks/' + f.task.id + '/analysis',
    payload: { key: randomUUID(), baseCandidateId: null },
  });
  expect(response.statusCode).toBe(202);
  await privateApp.close();
});

it.each([1, 3])('uses the same task lifecycle for %i Skill members with persisted correlation', async (count) => {
  const sourceFiles = Object.fromEntries(Object.entries(files).filter(([name]) => count > 1 || name.startsWith('skills/budget/') || name.startsWith('shared/')));
  sourceFiles['skills/budget/SKILL.md'] = encoded('---\nname: budget\ndescription: Query\n---\nReturn yuan.');
  const seen: BundleAgentInput[] = [];
  const f = await fixture(async input => {
    seen.push(input);
    expect(input.base.members).toHaveLength(count);
    return input.mode === 'ANALYZE'
      ? {status:'PRODUCED', analysis:{summary:'Preserve business semantics',changes:[],missing:[]}}
      : {status:'PRODUCED', files:input.base.files, delivery:{summary:'Complete candidate',services:[]}};
  }, undefined, sourceFiles);
  const app = Fastify({genReqId: () => 'server-generated-request'});
  registerBundleMigrationRoutes(app, f.service, true);
  try {
    const response = await app.inject({method:'POST',url:'/api/migration-tasks/'+f.task.id+'/analysis',
      headers:{'x-request-id':'untrusted-client-request'},payload:{key:randomUUID(),baseCandidateId:null}});
    expect(response.statusCode).toBe(202);
    await vi.waitFor(async () => expect((await f.service.get(f.task.id)).attempts.at(-1)?.status).toBe('COMPLETED'));
    const analyzed = await f.service.get(f.task.id);
    expect(seen[0]!.correlation).toMatchObject({taskId:f.task.id,attemptId:analyzed.attempts[0]!.id,requestId:'server-generated-request',agentRunId:analyzed.attempts[0]!.agentRunId});
    expect(analyzed.attempts[0]!.agentRunId).toMatch(/^agent-/);
    await f.start('GENERATE');
    await f.service.configure(f.task.id,config);
    await f.service.saveSuite(f.task.id,suite);
    await f.start('ACCEPT');
    const accepted = await f.start('ACCEPT',{phase:'holdout'});
    expect(accepted.runs.at(-1)?.status).toBe('PASSED');
    expect(accepted.attempts.at(-1)?.runId).toBe(accepted.runs.at(-1)?.id);
    const archive = unzipSync(await f.service.export(f.task.id,true));
    expect(JSON.parse(Buffer.from(archive['migration/manifest.json']!).toString()).verified).toBe(true);
    // Old bundle URL and canonical URL address exactly the same persistent record.
    expect((await app.inject('/api/migration-tasks/'+f.task.id)).json()).toEqual((await app.inject('/api/migration-tasks/'+f.task.id)).json());
  } finally { await app.close(); }
});

it('accepts a standalone root SKILL.md and rejects empty or oversized member sets', () => {
  const one = { 'SKILL.md':encoded('---\nname: single\ndescription: One\n---\nTask'), 'tool.py':encoded('print(1)') };
  expect(snapshot(one,'source').members).toHaveLength(1);
  expect(() => snapshot({'readme.txt':encoded('no skill')},'source')).toThrow('1–10');
  const many = Object.fromEntries(Array.from({length:11},(_,i)=>['s'+i+'/SKILL.md',encoded('---\nname: s'+i+'\ndescription: One\n---\nTask')]));
  expect(() => snapshot(many,'source')).toThrow('1–10');
});

it.each(['.env', 'shared/private.json'])('retains the legacy export credential gate for unified candidates (%s)', async name => {
  const f = await fixture(undefined, undefined, { ...files, [name]: encoded('{"api_key": "fixture-private-value"}') });
  await f.start('ANALYZE');
  await f.start('GENERATE');
  await expect(f.service.export(f.task.id)).rejects.toMatchObject({statusCode:409,code:'MIGRATION_EXPORT_CREDENTIALS'});
});
