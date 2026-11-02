import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {runMigrationAgent} from '../src/migration/infrastructure/migration-agent-runner.js';
const directories:string[]=[];
afterEach(async()=>{vi.unstubAllEnvs();for(const dir of directories.splice(0))await rm(dir,{recursive:true,force:true});});
async function stub(source:string){
 const root=await mkdtemp(path.join(os.tmpdir(),'platform-agent-wire-'));directories.push(root);
 await mkdir(path.join(root,'integrations/openjiuwen'),{recursive:true});
 await writeFile(path.join(root,'integrations/openjiuwen/platform_agent.py'),source);
 await writeFile(path.join(root,'.runtime.local.json'),'{}');
 vi.stubEnv('FINANCE_EVAL_MIGRATION_PYTHON',process.execPath);
 return root;
}
it.each(['diagnosis','migration','adjustment','standardization-review'] as const)('uses the one process entry for %s and preserves role and resource receipts',async role=>{
 const root=await stub("let text='';process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>{const body=JSON.parse(text);process.stdout.write(JSON.stringify({result:{status:'PRODUCED',payload:{role:body.stage,version:body.agentRoleVersion},composition:{role:body.stage}}})+'\\n');});");
 const result=await runMigrationAgent(role,{assetDigest:'a'.repeat(64),agentRoleVersion:'v1'},{projectRoot:root,modelId:'fixture'});
 expect(result.status).toBe('PRODUCED');expect(result.binding.stageId).toBe(role);
 expect(result.payload.judgement).toEqual({role,version:'v1'});expect(result.run.composition).toEqual({role});
});
it('retains the reason for a failed process result',async()=>{
 const root=await stub("process.stdout.write(JSON.stringify({result:{status:'FAILED',error:'具体缺口'}})+'\\n');");
 const result=await runMigrationAgent('diagnosis',{assetDigest:'a'.repeat(64)},{projectRoot:root,modelId:'fixture'});
 expect(result.status).toBe('FAILED');expect(result.run.error).toBe('具体缺口');
});
it('terminates the shared entry on cancellation',async()=>{
 const root=await stub("setTimeout(()=>{},60000);"),controller=new AbortController();
 const result=runMigrationAgent('migration',{assetDigest:'a'.repeat(64)},{projectRoot:root,modelId:'fixture',signal:controller.signal});
 controller.abort();await expect(result).rejects.toThrow();
});
