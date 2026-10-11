import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {zipSync} from 'fflate';

const root=fileURLToPath(new URL('../../',import.meta.url));
const destination=process.argv[2];
assert(destination,'Usage: node examples/fact-check-attribution-v011/freeze.mjs NEW_OUTPUT_DIRECTORY [fact-provenance-v5|fact-provenance-v6|fact-provenance-v7|fact-provenance-v8|fact-provenance-v9]');
const policy=process.argv[3]??'fact-provenance-v5';
assert(['fact-provenance-v5','fact-provenance-v6','fact-provenance-v7','fact-provenance-v8','fact-provenance-v9'].includes(policy),'Unsupported Judge cohort');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=path=>readFile(resolve(root,path));
const baseline=await read('examples/fact-check-demo/SKILL.md');
assert.equal(digest(baseline),'526e1088b4f4b2eb859c0ce5901fbf8103e31c2729c52ebb4cba9e9da8239664','Baseline changed');
// The v5 cohort distinguishes optional workspace receipts and repairs formatting
// quotations without changing verdicts. Never mix recorded v2/v3/v4 results.
const judge=Buffer.from((await read('src/goal-judge.ts')).toString('utf8').replace(/\r\n/g,'\n'));
assert.equal(digest(judge),policy==='fact-provenance-v5'?'dcf63a1a7eb4300114f3dd9f9c84865467d699c2e67b15e6b59b64fc94562920':policy==='fact-provenance-v6'?'f5ed283b93e0826d64bc3feef3272055e0a2c4ca55fe514f0587fc15899e2a75':'cc4e4fdae1627fbc0ed1d184f59dc141e6d2f5ba1bcd8dfa7334d719531ca65d','Judge changed: do not silently mix policies');
const evidenceSources={
  'src/judge-runtime-evidence.ts':policy==='fact-provenance-v5'?'54740e85b5353d9ec0b96b6953d141c9ab31ce6ba9a351081ce8c52ef138269a':policy==='fact-provenance-v6'?'f3be1a43428310a8561fc424575c98724f1ecc67604f2d41e0803beef818a4dc':policy==='fact-provenance-v7'?'5d0f65f3a96462d878988c7f501d122db506698adbc07c21ec79deebb027ce82':policy==='fact-provenance-v8'?'af3b37ef9cc6ff6e796a313e6bdaf0cb39bb8be021999ef6d74e2a348cbdb51b':'27c6b67d86ac538d5ae8101715810d094899c04fdd2e7b19ef2bb42c5bd7fb58',
  'src/judge-case-files.ts':'23f7510eb548c9f2a4cb27a48a660536c7b97d67ff8af40dd0dc4a7739a699ca',
};
for(const [file,expected]of Object.entries(evidenceSources)){
  assert.equal(digest(Buffer.from((await read(file)).toString('utf8').replace(/\r\n/g,'\n'))),expected,
    `Judge evidence module changed: ${file}; do not silently mix policies`);
}
const revision=await read('examples/fact-check-attribution-v011/SKILL.md');
const originals=JSON.parse(await read('examples/fact-check-attribution-v011/original-cases.json'));
const added=JSON.parse(await read('examples/fact-check-attribution-v011/new-cases.json'));
const cases=[...originals.cases,...added.cases];
assert.equal(cases.length,8);assert.equal(new Set(cases.map(c=>c.id)).size,8);
assert(cases.some(c=>c.id==='attribution-common-date'));
const suite=Buffer.from(JSON.stringify({name:'事实归属固定对照 v1',cases},null,2)+'\n');
const variants={baseline:{version:'0.1.0',body:baseline},revision:{version:'0.1.1',body:revision}};
const archives={},identities={};
for(const [name,variant]of Object.entries(variants)){
  archives[name]=Buffer.from(zipSync({'SKILL.md':[variant.body,{mtime:new Date('2020-01-01T00:00:00Z')}]},{level:6}));
  identities[name]={skillId:'fact-check-demo',version:variant.version,skillSha256:digest(variant.body),archiveSha256:digest(archives[name])};
}
const planned=[];
for(let repeat=1;repeat<=3;repeat++)for(const variant of repeat%2?['baseline','revision']:['revision','baseline'])for(const runtime of ['openjiuwen','agentscope'])for(const c of cases){
  planned.push({executionId:`${variant}-${runtime}-${c.id}-r${repeat}`,variant,runtime,caseId:c.id,repeat,status:'NOT_RUN'});
}
const manifest={schemaVersion:'fact-attribution-experiment.v1',status:'FROZEN_NOT_EXECUTED',frozenAt:new Date().toISOString(),
  repositoryCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
  variants:identities,suiteSha256:digest(suite),
  judge:{policy,sourceSha256:digest(judge),evidenceSources,sourceEncoding:'UTF8_LF',modelLabel:'gpt-6-astra'},
  execution:{modelLabel:'deepseek-v4-flash',temperature:0,top_p:1,max_tokens:2000,
    runtimes:{openjiuwen:'0.1.15',agentscope:'2.0.3'},businessDate:'2026-09-20',timeZone:'Asia/Shanghai',
    tools:[],repeatsPerCombination:3,totalPlanned:96,parameterEvidence:'REQUIRE_HOST_CONFIGURATION_AND_RECORD_CAPTURE_POSITION'},
  accounting:{includeAllAttempts:true,replacementRetries:false,reportSeparately:['execution','automaticAssessment','humanReview'],
    failedOrMissingExecution:'retain denominator; do not score as a completed answer',
    alteredCaseOrSkill:'new cohort; never replace failed row'},
  gates:['Check deployed model/parameter/runtime/Judge identities before launch','Preserve both Skill digests and loaded identities',
    'New cases frozen before any model output','Native runtimes, fresh session per case','Do not modify Host or score policy'],planned};
await mkdir(destination,{mode:0o700});
for(const [name,bytes]of Object.entries(archives))await writeFile(resolve(destination,name+'.zip'),bytes,{flag:'wx',mode:0o600});
await writeFile(resolve(destination,'suite.json'),suite,{flag:'wx',mode:0o600});
await writeFile(resolve(destination,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({status:manifest.status,totalPlanned:planned.length,suiteSha256:manifest.suiteSha256,variants:identities}));
