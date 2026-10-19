import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { expect, it } from 'vitest';
import { createEvaluationService } from '../src/service/server.js';

it('preserves legacy records and exports while copying assets into a fresh unified task', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'migration-compat-'));
  const headers = { authorization: 'Bearer test-private-token' };
  const options = { dataDirectory: root, rootDirectory: path.resolve('.'), publicDirectory: path.resolve('web-dist'), accessToken: 'test-private-token' };
  let app = await createEvaluationService(options);
  try {
    const zip = Buffer.from(zipSync({
      'SKILL.md': Buffer.from('---\nname: historical\ndescription: Query budget\n---\nUse the packaged business code.'),
      'tools/query.py': Buffer.from('print("business result")'),
    }));
    const uploaded = await app.inject({ method: 'POST', url: '/api/migrations/upload', headers: { ...headers, 'content-type': 'application/zip' }, payload: zip });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    const source = uploaded.json();
    const created = await app.inject({ method: 'POST', url: '/api/migrations', headers,
      payload: { sourceAssetId: source.assetId, name: 'Historical task' } });
    expect(created.statusCode, created.body).toBe(200);
    const old = created.json();
    const before = (await app.inject({ url: '/api/migrations/' + old.id, headers })).json();
    const imported = await app.inject({ method: 'POST', url: '/api/migration-tasks/from-legacy/' + old.id, headers,
      payload: { name: 'Unified successor', goal: 'Preserve budget lookup', target: 'OpenJiuwen', selection: 'source' } });
    expect(imported.statusCode, imported.body).toBe(200);
    const task = imported.json();
    expect(task.source.members).toHaveLength(1);
    expect(task.origin).toEqual({ kind: 'legacy-project', projectId: old.id, assetId: source.assetId, selection: 'source' });
    expect(task.requestId).toBe(imported.headers['x-request-id']);
    expect(task.currentCandidateId).toBeNull();
    expect(task.runs).toEqual([]);
    expect(task.attempts).toEqual([]);
    expect(task.configuration).toBeUndefined();
    expect((await app.inject({ url: '/api/migrations/' + old.id, headers })).json()).toEqual(before);
    const missingCandidate = await app.inject({ method: 'POST', url: '/api/migration-tasks/from-legacy/' + old.id, headers,
      payload: { name: 'Missing candidate', goal: 'Budget', target: 'Runtime', selection: 'candidate' } });
    expect(missingCandidate.statusCode).toBe(409);
    const anonymous = await app.inject('/api/migration-tasks/' + task.id);
    expect(anonymous.statusCode).toBe(401);
    await app.close();
    app = await createEvaluationService(options);
    const restored = await app.inject({ url: '/api/migration-tasks/' + task.id, headers });
    expect(restored.json()).toEqual(task);
    expect((await app.inject({ url: '/api/migration-bundles/' + task.id, headers })).json()).toEqual(task);
    expect((await app.inject({ url: '/api/migrations/' + old.id, headers })).json()).toEqual(before);
    const copied = await app.inject({ url: '/api/migration-tasks/' + task.id + '/file?path=members/member-1/tools/query.py', headers });
    expect(copied.json().content).toBe('print("business result")');
    // Simulate a persisted historical candidate and earlier read-only schema.
    const historicalCandidate = { ...before, candidate: source, candidateNotes: 'Historical candidate', assessment: 'NOT_VALIDATED' };
    await writeFile(path.join(root,'migrations',old.id+'.json'),JSON.stringify(historicalCandidate));
    const candidateCopy = await app.inject({method:'POST',url:'/api/migration-tasks/from-legacy/'+old.id,headers,
      payload:{name:'Candidate continuation',goal:'Revalidate',target:'OpenJiuwen',selection:'candidate'}});
    expect(candidateCopy.statusCode,candidateCopy.body).toBe(200);
    expect(candidateCopy.json().origin.selection).toBe('candidate');
    expect(candidateCopy.json().candidates).toEqual([]);
    const exported = await app.inject({url:'/api/migrations/'+old.id+'/export',headers});
    expect(exported.statusCode,exported.body).toBe(200);
    expect(exported.headers['x-migration-acceptance']).toBe('UNVERIFIED');
    const v1 = {schemaVersion:'finance.skill-migration.v0.1',id:'migration-abcdef',name:'Earlier record',createdAt:'2025-01-01',notes:'Preserve exactly'};
    await writeFile(path.join(root,'migrations',v1.id+'.json'),JSON.stringify(v1));
    const historicalExport = await app.inject({url:'/api/migrations-legacy/'+v1.id+'/export',headers});
    expect(historicalExport.statusCode,historicalExport.body).toBe(200);
    expect(historicalExport.json()).toEqual(v1);
    const files = await readdir(path.join(root, 'migration-bundles', 'tasks'));
    expect(files).toHaveLength(2);
    expect(files).toContain(task.id + '.json');
    expect(JSON.parse(await readFile(path.join(root, 'migration-bundles', 'tasks', files[0]!), 'utf8')).schemaVersion).toBe('finance.skill-migration.bundle.v1');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
