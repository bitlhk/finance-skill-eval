import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {zipSync} from 'fflate';

const root=fileURLToPath(new URL('../../',import.meta.url));
const destination=process.argv[2];
assert(destination,'Usage: node examples/fact-check-attribution-v011/freeze.mjs NEW_OUTPUT_DIRECTORY');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=path=>readFile(resolve(root,path));
const baseline=await read('examples/fact-check-demo/SKILL.md');
assert.equal(digest(baseline),'526e1088b4f4b2eb859c0ce5901fbf8103e31c2729c52ebb4cba9e9da8239664','Baseline changed');
// Source-result collection guidance is a new v4 cohort, not a replacement for
// any recorded v2/v3 results. Pin imported prompt/evidence modules as well.
const judge=Buffer.from((await read('src/goal-judge.ts')).toString('utf8').replace(/\r\n/g,'\n'));
assert.equal(digest(judge),'1ec4a6dfe0da6eac892548675c895a4c182a6a501d2ed72de837ccc6faf42de7','Judge changed: do not silently mix policies');
const evidenceSources={
  'src/judge-runtime-evidence.ts':'54740e85b5353d9ec0b96b6953d141c9ab31ce6ba9a351081ce8c52ef138269a',
  'src/judge-case-files.ts':'3bf988b273046bd14188208761978804cd08e5f363dda8b3c8ae4dc84392c64e',
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
  judge:{policy:'fact-provenance-v4',sourceSha256:digest(judge),evidenceSources,sourceEncoding:'UTF8_LF',modelLabel:'gpt-6-astra'},
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
