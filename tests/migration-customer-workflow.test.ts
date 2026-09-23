import {it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {zipSync,strToU8,unzipSync} from 'fflate';
import {SkillStore} from '../src/service/skill-store.js';
import {MigrationDiagnostics} from '../src/migration/infrastructure/migration-diagnostics.js';
import {generateCandidateFiles,regenerationArchive} from '../src/migration/infrastructure/legacy-candidate-generator.js';
import {importMigrationFiles} from '../web/src/migration-import.js';
import {createEvaluationService} from '../src/service/server.js';

it('diagnoses a different business method and generates inert generic ports without borrowing PF profiles',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'customer-migration-'));
  try{
    const store=new SkillStore(dir);await store.initialize();
    const content={'shipment/SKILL.md':'---\nname: shipment-review\nversion: 1.0\n---\n- `lookup_shipment`\nUse `references/delivery.md` and report unresolved deliveries.',
      'shipment/references/delivery.md':'Compare delivery dates. Never invent a signature.',
      'shipment/Adapter.java':'// import com.openjiuwen.Fake;\nimport com.openjiuwen.core.foundation.tool.Tool;\nclass Adapter {}',
      'shipment/port.py':'import unknown_delivery_sdk\ndef lookup_shipment(tracking_id):\n    return unknown_delivery_sdk.find(tracking_id)\n'};
    const asset=await store.uploadZip(Buffer.from(zipSync(Object.fromEntries(Object.entries(content).map(([k,v])=>[k,strToU8(v)])))));
    const diagnostics=new MigrationDiagnostics(process.cwd(),dir,store,()=>({configured:false,adapter:null,model:{providerId:'none',modelId:'none',parameters:{}}}));
    const diagnosis=await diagnostics.diagnose(asset);
    expect(diagnosis.frameworks).toEqual(['OpenJiuwen']);expect(diagnosis.status).toBe('PARTIAL');
    expect(diagnosis.plan?.some(p=>p.category==='ENGINEERING'&&p.findingIds.length)).toBe(true);
    const archive=await store.readArchive(asset.assetId);
    const result=generateCandidateFiles(archive,asset,diagnosis,'2.0',{runtime:'openjiuwen',intent:'preserve_business_method'});
    const contract=JSON.parse(Buffer.from(result.files['migration-generated/neutral-contract.json']!).toString());
    expect(contract.capabilities.map((c:any)=>c.name)).toEqual(['lookup_shipment']);
    expect(contract.capabilities[0].inputSchema).toBeNull();expect(contract.executionProfile).toBeUndefined();
    expect(Buffer.from(result.files['shipment/references/delivery.md']!)).toEqual(Buffer.from(archive['shipment/references/delivery.md']!));
    expect(()=>regenerationArchive({...result.files,'migration-generated/custom.py':strToU8('do_not_overwrite')},asset)).toThrow('自定义');
  }finally{await rm(dir,{recursive:true,force:true});}
});

it('batch intake isolates failures, preserves content and bounds count without executing anything',async()=>{
  const collected:Record<string,Uint8Array>[]=[];
  const files=[new File([zipSync({'skill/SKILL.md':strToU8('plain instructions')})], 'method.zip'),new File(['bad'], 'bad.exe'),new File([zipSync({'skill/SKILL.md':strToU8('another method')})], 'another.zip')];
  const result=await importMigrationFiles(files,async bytes=>{collected.push(unzipSync(bytes));});
  expect(result.map(r=>r.status)).toEqual(['IMPORTED','FAILED','IMPORTED']);
  expect(Buffer.from(collected[0]!['skill/SKILL.md']!).toString()).toBe('plain instructions');
  expect(Buffer.from(collected[1]!['skill/SKILL.md']!).toString()).toBe('another method');
  await expect(importMigrationFiles(Array(11).fill(files[0]),async()=>{})).rejects.toThrow('10');
});

it('does not silently select one Skill from a multi-Skill ZIP',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'multi-skill-'));
  try{const store=new SkillStore(dir);await store.initialize();
    await expect(store.uploadZip(Buffer.from(zipSync({'SKILL.md':strToU8('one'),'nested/SKILL.md':strToU8('two')})))).rejects.toThrow('多个 Skill 入口');
    expect(await store.list()).toHaveLength(0);
  }finally{await rm(dir,{recursive:true,force:true});}
});

it('imports a migration ZIP without judging its layout',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'migration-envelope-'));
  try{const store=new SkillStore(dir);await store.initialize();
    const valid=Buffer.from(zipSync({'skill/SKILL.md':strToU8('---\nname: envelope\ndescription: 测试标准迁移上传包。\n---\n信息缺失时返回错误。'),'skill/scripts/local.py':strToU8('print("ok")'),'tool/src/service.py':strToU8('def service(): pass')}));
    const record=await store.uploadMigrationZip(valid);
    expect(record.skillFile).toBe('skill/SKILL.md');
    expect(record.artifactSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(record.fileCount).toBe(3);
    expect((await store.uploadMigrationZip(Buffer.from(zipSync({'skill/instructions.md':strToU8('legacy instructions')})))).skillFile).toBe('skill/instructions.md');
    expect((await store.uploadMigrationZip(Buffer.from(zipSync({'skill/skill.md':strToU8('first'),'skill/nested/SKILL.md':strToU8('second')})))).skillFile).toBe('skill/skill.md');
    // 布局不判：嵌套 skill 目录可以
    expect((await store.uploadMigrationZip(Buffer.from(zipSync({'wrapper/skill/SKILL.md':strToU8('nested')})))).skillFile).toBe('wrapper/skill/SKILL.md');
    // 布局不判：skill/ tool/ 之外的顶层文件可以
    expect((await store.uploadMigrationZip(Buffer.from(zipSync({'skill/SKILL.md':strToU8('ok'),'README.md':strToU8('extra')})))).skillFile).toBe('skill/SKILL.md');
    // 凭据文件不在导入时拒绝；导出侧才是关卡
    expect((await store.uploadMigrationZip(Buffer.from(zipSync({'skill/SKILL.md':strToU8('ok'),'tool/.env':strToU8('TOKEN=secret')})))).skillFile).toBe('skill/SKILL.md');
    // 安全限制仍然生效
    await expect(store.uploadMigrationZip(Buffer.alloc(0))).rejects.toThrow('8 MB');
    await expect(store.uploadMigrationZip(Buffer.from(zipSync({'skill/../escape.md':strToU8('x')})))).rejects.toThrow(/Unsafe|path/u);
  }finally{await rm(dir,{recursive:true,force:true});}
});

it('does not export an uploaded credential file alongside a candidate',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'migration-secrets-'));
  const app=await createEvaluationService({rootDirectory:process.cwd(),dataDirectory:dir,accessToken:'private',publicDemo:false});
  const headers={authorization:'Bearer private'};
  try{
    const asset=(await app.inject({method:'POST',url:'/api/skills/upload',headers:{...headers,'content-type':'application/zip'},payload:Buffer.from(zipSync({'SKILL.md':strToU8('---\nname: method\nversion: 1.0.0\n---\nSummarize facts.'),'.env':strToU8('EXAMPLE=not-a-real-credential')}))})).json();
    const project=(await app.inject({method:'POST',url:'/api/migrations',headers,payload:{sourceAssetId:asset.assetId,name:'secret-path-test'}})).json();
    expect((await app.inject({method:'POST',url:`/api/migrations/${project.id}/generate`,headers,payload:{runtime:'openjiuwen',intent:'preserve_business_method',baseAssetId:asset.assetId}})).statusCode).toBe(200);
    const response=await app.inject({url:`/api/migrations/${project.id}/export`,headers});
    expect(response.statusCode).toBe(409);expect(response.body).not.toContain('not-a-real-credential');
  }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
