import { taskHttpFixture, standardFiles, encode } from './task-http-fixture.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { expect, it } from 'vitest';
import { createEvaluationService } from '../src/service/server.js';

it("separates development feedback from holdout and rejects unrelated repair records",async()=>{

 const f=await taskHttpFixture();await f.ready();f.control.verdict=false;
 const dev=(await f.finish('acceptance')).runs.at(-1)!;await f.finish('repair',{runId:dev.id});
 expect(JSON.stringify(f.seen.at(-1)?.feedback)).toContain('Review document');expect(JSON.stringify(f.seen.at(-1))).not.toContain('HOLDOUT_SECRET');
 const held=(await f.finish('acceptance',{phase:'holdout'})).runs.at(-1)!;
 expect((await f.start('repair',{runId:held.id})).statusCode).toBe(409);expect((await f.start('repair',{runId:'foreign-run'})).statusCode).toBe(409);
 expect((await f.api('PUT',f.url()+'/suite',{name:'invalid',cases:[]})).statusCode).toBe(400);

});
