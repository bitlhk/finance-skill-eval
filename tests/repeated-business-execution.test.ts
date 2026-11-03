import {expect,it,vi} from 'vitest';
import {acceptMigrationTask} from '../src/migration/tasks/application/task-acceptance.js';
import {completedRepetitions,projectSnapshot,verifiedRun,type BundleTask,type BundleAttempt} from '../src/migration/tasks/domain/task-model.js';
import {simpleMigrationSuiteSchema} from '../src/migration/domain/simple-migration-suite.js';
import type {BundleRuntimeFactory} from '../src/migration/tasks/application/task-ports.js';

it.each(['stable','variable','broken','unverified'] as const)('runs separate real invocations and preserves the complete group: %s',async mode=>{
  const source=projectSnapshot({'main.py':Buffer.from('print(1)').toString('base64')});
  const attempt={id:'attempt'} as BundleAttempt;
  const task={id:'task',preparations:[{id:'prepared',digest:source.digest}],baselineConfiguration:{environmentId:'test',modelId:'test'},
    suite:simpleMigrationSuiteSchema.parse({name:'test',executionRepetitions:3,cases:[{id:'case',input:'Read',criteria:['Read correctly'],repeatSafety:'read_only'}]}),
    runs:[],attempts:[attempt]} as unknown as BundleTask;
  const cleanup=vi.fn(),judge=vi.fn(async()=>mode==='unverified'?{passed:false,unverified:true,reason:'Missing receipt',criteria:[{id:'goal-1',passed:null,reason:'Missing receipt',evidenceRefs:[]}]}:{passed:mode!=='variable'||judge.mock.calls.length!==2,reason:'Frozen rubric'});
  const runtime=vi.fn<BundleRuntimeFactory>(async()=>{
    if(mode==='broken')throw Error('runtime unavailable');
    return {model:{providerId:'test',modelId:'test',parameters:{}},environmentSnapshot:{id:'same-environment'},runtime:{adapterId:'fixture',cleanup,
      execute:async request=>({runId:request.runId,side:request.side,caseId:request.evalCase.caseId,status:'completed',modelId:'test',skillVersion:null,
        output:'Read',elapsedMs:1,loadedSkills:[],toolCalls:[],usage:null,runtimeIdentityVerified:true,streamCompleted:true,error:null,
        metadata:{projectExecution:true,contentDigest:source.digest}})}};
  });
  await acceptMigrationTask({update:async(_id,change)=>{await change(task);return task;},readSnapshot:async()=>source,
    progress:async()=>{},runtime,judge},task,attempt,'development',new AbortController().signal,'baseline');
  expect(runtime).toHaveBeenCalledTimes(mode==='broken'?1:3);
  expect(cleanup).toHaveBeenCalledTimes(mode==='broken'?0:3);
  expect(new Set(task.runs.map(r=>r.id)).size).toBe(task.runs.length);
  expect(new Set(task.runs.map(r=>r.repetition!.groupId)).size).toBe(1);
  const group=completedRepetitions(task,task.runs.at(-1)!);
  if(mode==='broken'||mode==='unverified')expect(group).toBeUndefined();
  else {expect(group).toHaveLength(3);expect(group!.every(r=>r.status==='PASSED')).toBe(mode==='stable');}
  if(mode==='variable')expect(task.runs.map(r=>r.status)).toEqual(['PASSED','FAILED','PASSED']);
  if(mode==='unverified')expect(task.runs.map(r=>r.status)).toEqual(['INCOMPLETE','INCOMPLETE','INCOMPLETE']);
  const candidateTask={...task,currentCandidateId:'prepared',configuration:task.baselineConfiguration,
    runs:task.runs.map(run=>({...run,purpose:'candidate' as const}))};
  expect(Boolean(verifiedRun(candidateTask))).toBe(mode==='stable');
});
