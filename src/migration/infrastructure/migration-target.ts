import {readFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import {z} from 'zod';
import {canonicalNeutralArchive} from '../../service/neutral-archive.js';
import {runtimeExecutionEvidenceSchema,stableJson} from '../../contracts.js';
import {readJson,writeJsonAtomic} from '../../service/file-store.js';
import type {SkillAssetRecord} from '../../shared/contracts/skill-asset.js';
import type {MigrationSkillRepository} from '../application/migration-skill-repository.js';
import type {MigrationTargetGateway} from '../application/migration-target-gateway.js';
import type {MigrationNativeTarget,MigrationTargetRun} from '../domain/migration-target.js';

const tool=z.object({name:z.string(),description:z.string(),inputSchema:z.record(z.unknown()),outputSchema:z.record(z.unknown())});
const profile=z.object({label:z.string(),skillId:z.string(),schemaBasis:z.string(),tools:z.array(tool),cases:z.array(z.object({caseId:z.string(),label:z.string(),expect:z.enum(['completed','denied']),prompt:z.string()}))});
const healthSchema=z.object({hostId:z.literal('finance-migration-openjiuwen-reference-v1'),version:z.literal('0.1.13'),hostSha256:z.string().regex(/^[a-f0-9]{64}$/),sdkSha256:z.literal('65561515ace2d44a1f2448d54fcdf2a2e09eadb8ba5be715836975f3fc4d64ea'),modelId:z.string().min(1),modelConfigured:z.literal(true),sourceKind:z.literal('CONTROLLED_SYNTHETIC_BANK'),fixturesSha256:z.string(),portsSha256:z.string(),profiles:z.record(profile)});
export type NativeTarget=MigrationNativeTarget;
export type TargetRun=MigrationTargetRun;
const pending=new Set<string>();
const runnerInstanceId=randomUUID();
async function headers(){const file=process.env.FINANCE_MIGRATION_NATIVE_TOKEN_FILE;if(!file)throw new Error('目标 Host 尚未配置');return {Authorization:'Bearer '+(await readFile(file,'utf8')).trim(),'Content-Type':'application/json'};}
function endpoint(){const value=process.env.FINANCE_MIGRATION_NATIVE_ENDPOINT;if(!value)throw new Error('目标 Host 尚未配置');const url=new URL(value);if(url.hostname!=='127.0.0.1'||url.protocol!=='http:')throw new Error('迁移 Host 必须使用可信本机连接');return url;}
export async function nativeTarget(){const url=endpoint();url.pathname='/health';const response=await fetch(url,{headers:await headers(),signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error('目标 Host 健康检查失败');return healthSchema.parse(await response.json());}
export class MigrationTargetRuns implements MigrationTargetGateway {
  constructor(private root:string,private skills:MigrationSkillRepository){}
  private file(id:string){if(!/^target-[a-f0-9-]+$/.test(id))throw new Error('Invalid target run');return path.join(this.root,'migration-target-runs',id+'.json');}
  target(){return nativeTarget();}
  async get(id:string):Promise<TargetRun>{
    const value=await readJson<TargetRun>(this.file(id));
    if(value.status==='RUNNING'&&value.runnerInstanceId!==runnerInstanceId)
      return {...value,status:'INTERRUPTED',error:'运行已中断，请重新验证当前候选'};
    return value;
  }
  async start(asset:SkillAssetRecord,profileId:string){
    const target=await nativeTarget(),selected=target.profiles[profileId];if(!selected||selected.skillId!==asset.skillId)throw new Error('模拟端口与当前方法不匹配');
    const files=await this.skills.readArchive(asset.assetId),canonicalArchive=canonicalNeutralArchive(files,asset.artifactSha256);
    const contract=JSON.parse(Buffer.from(files['migration-generated/neutral-contract.json']!).toString());
    if(contract.executionProfile!==profileId||contract.mappingReview?.portsSha256!==target.portsSha256)throw new Error('端口定义已变化，请重新审阅并生成候选');
    if(pending.size>=2)throw Object.assign(new Error('目标环境已有两个验证任务，请等待完成后再试'),{statusCode:409});
    const value:TargetRun={id:'target-'+randomUUID(),assetId:asset.assetId,candidateDigest:asset.artifactSha256,startedAt:new Date().toISOString(),status:'RUNNING',profile:profileId,runnerInstanceId,target,cases:[]};
    pending.add(value.id);try{await writeJsonAtomic(this.file(value.id),value);}catch(e){pending.delete(value.id);throw e;}
    void this.execute(value,asset,canonicalArchive).finally(()=>pending.delete(value.id)).catch(()=>{});return value;
  }
  private async execute(value:TargetRun,asset:SkillAssetRecord,canonicalArchive:string){try{
    const entries=JSON.parse(canonicalArchive) as Array<{name:string;content:string}>;
    const files=Object.fromEntries(entries.map(e=>[e.name,Buffer.from(e.content,'base64')]));
    const contract=JSON.parse(files['migration-generated/neutral-contract.json']!.toString());
    const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
    const methodHash=hash(files[contract.method]!);
    const resources=contract.resources.map((r:{path:string;visibility:string})=>({path:r.path,visibility:r.visibility,sha256:hash(files[r.path]!)}));
    for(const c of value.target.profiles[value.profile]!.cases){
      const current=await nativeTarget();if(current.hostSha256!==value.target.hostSha256||current.portsSha256!==value.target.portsSha256||current.fixturesSha256!==value.target.fixturesSha256)throw new Error('TARGET_CHANGED');
      const response=await fetch(endpoint(),{method:'POST',headers:await headers(),signal:AbortSignal.timeout(310000),body:JSON.stringify({schemaVersion:'finance.skill-eval.runtime-request.v1',runId:value.id,side:'right',case:c,model:{modelId:value.target.modelId},skill:{skillId:asset.skillId,version:asset.version,artifactSha256:asset.artifactSha256,canonicalArchive}})});
      if(!response.ok)throw new Error('HOST_EXECUTION_REJECTED');
      const evidence=runtimeExecutionEvidenceSchema.parse(await response.json()),m=evidence.metadata;
      const identity=evidence.runId===value.id&&evidence.caseId===c.caseId&&evidence.side==='right'&&evidence.modelId===value.target.modelId&&m.skillArtifactSha256===asset.artifactSha256&&m.hostSha256===value.target.hostSha256&&m.sdkSha256===value.target.sdkSha256&&m.fixturesSha256===value.target.fixturesSha256&&evidence.loadedSkills.some(s=>s.skillId===asset.skillId&&s.version===asset.version);
      const expected=value.target.profiles[value.profile]!.tools.map(t=>t.name);
      const success=c.expect==='denied'?evidence.status==='failed'&&evidence.error==='AUTHORIZATION_REJECTED'&&m.modelCalls===0&&m.businessReads===0:
        evidence.status==='completed'&&evidence.streamCompleted&&Number(m.modelResponses)>=2&&Number(m.businessReads)>=expected.length&&expected.every(name=>evidence.toolCalls.some(t=>t.name===name&&t.status==='completed'))&&!evidence.toolCalls.some(t=>t.status==='failed')&&evidence.output.trim().length>0;
      const loaded=m.methodSha256===methodHash&&stableJson(m.resources)===stableJson(resources);
      const missing=c.caseId!=='pf-missing'||evidence.output.includes('财报未披露短期借款明细');
      value.cases.push({caseId:c.caseId,label:c.label,passed:identity&&success&&loaded&&missing,evidence});await writeJsonAtomic(this.file(value.id),value);
      if(!identity||!success||!loaded||!missing)throw new Error('CASE_ASSERTION_FAILED');
    }
    value.status='PASSED';
  }catch(error){value.status='FAILED';const reason=error instanceof Error?error.message:'UNKNOWN_ERROR';
    value.error=`目标执行或证据检查未通过（${reason}）；查看已完成案例，修正后重试。`;}
    value.finishedAt=new Date().toISOString();await writeJsonAtomic(this.file(value.id),value);
  }
}
