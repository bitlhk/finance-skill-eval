import {expect,it,vi} from 'vitest';
import {analyzeSavedRun,runDiagnosisInput} from '../src/migration/tasks/application/task-run-analysis.js';
import {projectSnapshot,type BundleRun,type BundleTask} from '../src/migration/tasks/domain/task-model.js';
import {simpleMigrationSuiteSchema} from '../src/migration/domain/simple-migration-suite.js';
const snapshot=projectSnapshot({'app.py':Buffer.from('print("original")').toString('base64')});
const run={id:'run',candidateId:'preparation',candidateDigest:snapshot.digest,phase:'development',status:'FAILED',
  suite:simpleMigrationSuiteSchema.parse({name:'test',cases:[{id:'one',input:'Task',criteria:['Result']},{id:'missing',input:'Not run',criteria:['Result']}],holdoutCases:[{id:'secret',input:'HOLDOUT_SECRET',criteria:['Hidden']}]}),
  cases:[{id:'one',passed:false,reason:'Judge error',failureStage:'JUDGE'}]} as BundleRun;
const task={candidates:[],runs:[run]} as unknown as BundleTask;
it('classifies unavailable cases and binds code to the frozen run without leaking holdout',()=>{
  const input=runDiagnosisInput(task,run,snapshot);
  expect(input.cases.map(c=>c.verdict)).toEqual(['JUDGE','NOT_RUN']);
  expect(JSON.stringify(input)).not.toContain('HOLDOUT_SECRET');
  expect(()=>runDiagnosisInput(task,{...run,phase:'holdout'},snapshot)).toThrow('留出');
  expect(()=>runDiagnosisInput(task,{...run,candidateDigest:'changed'},snapshot)).toThrow('快照');
});
it('rejects invented case references and a cancelled investigation without persisting a result',async()=>{
  const diagnose=vi.fn(async()=>({judgement:{status:'PROPOSED',hypothesis:{evidenceCaseIds:['secret']}}} as any));
  await expect(analyzeSavedRun(task,run,snapshot,diagnose,new AbortController().signal)).rejects.toThrow('之外');
  const controller=new AbortController();
  diagnose.mockImplementationOnce(async()=>{controller.abort(new Error('cancel'));return {judgement:{status:'ABSTAINED',reason:'no evidence'}} as any;});
  await expect(analyzeSavedRun(task,run,snapshot,diagnose,controller.signal)).rejects.toThrow('cancel');
});
