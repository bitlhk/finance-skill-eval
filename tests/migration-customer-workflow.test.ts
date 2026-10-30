import { taskHttpFixture, standardFiles, encode } from './task-http-fixture.js';
import {it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {zipSync,strToU8,unzipSync} from 'fflate';
import {SkillStore} from '../src/service/skill-store.js';
import {importMigrationFiles} from '../web/src/migration-import.js';
import {createEvaluationService} from '../src/service/server.js';

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

it("blocks credential-bearing candidate export through the standard task endpoint",async()=>{

 const f=await taskHttpFixture({files:{...standardFiles,'.env':encode('API_KEY=sk-live-secret-do-not-export-123456789')}});
 await f.candidate();const result=await f.api('GET',f.url()+'/export');expect(result.statusCode).toBe(409);
 expect(result.body).not.toContain('sk-live-secret-do-not-export');

});
