import {it,expect} from 'vitest';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {unzipSync,strFromU8} from 'fflate';
import {simpleMigrationSuiteSchema} from '../src/migration/domain/simple-migration-suite.js';

it('freezes an explicitly separate v9 cohort and refuses silently relabeling v5/v6/v7/v8, preserving baseline and cases',async()=>{
  const root=await mkdtemp(join(tmpdir(),'fact-attribution-'));
  const output=join(root,'frozen');
  try{
    expect(()=>execFileSync(process.execPath,['examples/fact-check-attribution-v011/freeze.mjs',output],{stdio:'pipe'})).toThrow(/Judge changed/);
    expect(()=>execFileSync(process.execPath,['examples/fact-check-attribution-v011/freeze.mjs',output,'fact-provenance-v6'],{stdio:'pipe'})).toThrow(/Judge changed/);
    expect(()=>execFileSync(process.execPath,['examples/fact-check-attribution-v011/freeze.mjs',output,'fact-provenance-v7'],{stdio:'pipe'})).toThrow(/Judge evidence module changed/);
    expect(()=>execFileSync(process.execPath,['examples/fact-check-attribution-v011/freeze.mjs',output,'fact-provenance-v8'],{stdio:'pipe'})).toThrow(/Judge evidence module changed/);
    execFileSync(process.execPath,['examples/fact-check-attribution-v011/freeze.mjs',output,'fact-provenance-v9']);
    const manifest=JSON.parse(await readFile(join(output,'manifest.json'),'utf8'));
    expect(manifest.judge.policy).toBe('fact-provenance-v9');
    for(const [file,hash]of Object.entries(manifest.judge.evidenceSources)){
      expect(createHash('sha256').update((await readFile(file,'utf8')).replace(/\r\n/g,'\n')).digest('hex')).toBe(hash);
    }
    const suite=simpleMigrationSuiteSchema.parse(JSON.parse(await readFile(join(output,'suite.json'),'utf8')));
    const original=JSON.parse(await readFile('examples/fact-check-attribution-v011/original-cases.json','utf8'));
    expect(suite.cases.slice(0,4)).toEqual(original.cases);
    expect(suite.cases.some(c=>c.id==='attribution-common-date')).toBe(true);
    expect(manifest.planned).toHaveLength(96);
    expect(new Set(manifest.planned.map((r:{executionId:string})=>r.executionId)).size).toBe(96);
    for(const variant of ['baseline','revision'])for(const runtime of ['openjiuwen','agentscope'])for(const c of suite.cases){
      expect(manifest.planned.filter((r:{variant:string;runtime:string;caseId:string})=>r.variant===variant&&r.runtime===runtime&&r.caseId===c.id).map((r:{repeat:number})=>r.repeat)).toEqual([1,2,3]);
    }
    expect(manifest.planned.every((r:{status:string})=>r.status==='NOT_RUN')).toBe(true);
    const old=unzipSync(await readFile(join(output,'baseline.zip')));
    expect(strFromU8(old['SKILL.md']!)).toBe(await readFile('examples/fact-check-demo/SKILL.md','utf8'));
    expect(manifest.variants.revision.skillSha256).not.toBe(manifest.variants.baseline.skillSha256);
    expect(()=>execFileSync(process.execPath,['examples/fact-check-attribution-v011/freeze.mjs',output,'fact-provenance-v8'],{stdio:'pipe'})).toThrow();
  }finally{await rm(root,{recursive:true,force:true})}
});
