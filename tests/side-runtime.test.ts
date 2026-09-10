import { afterEach, expect, it, vi } from 'vitest';
import { SideRuntimeAdapter } from '../src/side-runtime.js';
import { HttpRuntimeAdapter } from '../src/http-runtime.js';
import { runConfigurationSchema } from '../src/service/contracts.js';
import { loadEvalPack } from '../src/eval-pack.js';

afterEach(()=>vi.unstubAllGlobals());
it('routes independent sides and cleans both after second prepare fails',async()=>{
  const calls:string[]=[];
  const make=(side:string)=>({adapterId:side,prepare:async()=>{calls.push(side+' prepare');if(side==='right')throw Error('prepare');},
    execute:vi.fn(),cleanup:async()=>{calls.push(side+' cleanup');}});
  const adapter=new SideRuntimeAdapter({left:make('left'),right:make('right')});
  await expect(adapter.prepare()).rejects.toThrow('prepare');
  await adapter.cleanup(); await adapter.cleanup();
  expect(calls).toEqual(['left prepare','right prepare','right cleanup','left cleanup']);
});
it('cleanup failures do not skip the other side',async()=>{
  const left={adapterId:'left',execute:vi.fn(),cleanup:vi.fn()},right={adapterId:'right',execute:vi.fn(),cleanup:vi.fn(async()=>{throw Error('cleanup');})};
  const adapter=new SideRuntimeAdapter({left,right});await adapter.prepare();
  await expect(adapter.cleanup()).rejects.toThrow('cleanup');expect(left.cleanup).toHaveBeenCalledOnce();
});
it('keeps plain runs compatible but rejects direct/replay migration and unequal models',()=>{
  expect(runConfigurationSchema.parse({packId:'p',runtime:{type:'replay'}}).runtime.type).toBe('replay');
  const base={packId:'p',runtime:{type:'runtime_http',environmentId:'a'},runtimeBindings:{left:{environmentId:'a',skillAssetId:'s1'},right:{environmentId:'b',skillAssetId:'s2'}},
    leftVariant:{mode:'skill_version',skillId:'s',version:'1'},rightVariant:{mode:'skill_version',skillId:'s',version:'2'},executionModel:{providerId:'p',modelId:'m'}};
  expect(runConfigurationSchema.safeParse(base).success).toBe(true);
  expect(runConfigurationSchema.safeParse({...base,runtime:{type:'direct_model'}}).success).toBe(false);
  expect(runConfigurationSchema.safeParse({...base,rightExecutionModel:{providerId:'p',modelId:'other'}}).success).toBe(false);
});
it.each([undefined,'bad','digest'])('requires the observed digest and routes the requested side: %s',async(digest)=>{
  const pack=await loadEvalPack('packs/finance/investment-research/eval.yaml');
  const variant={mode:'skill_version' as const,skillId:'s',version:'1'};
  const skill={skillId:'s',version:'1',artifactSha256:'digest',instructions:'read only',files:{'SKILL.md':'read only'}};
  const evidence={runId:'remote',side:'right',caseId:pack.cases[0]!.caseId,status:'completed',modelId:'m',skillVersion:'1',output:'ok',elapsedMs:1,
    toolCalls:[],loadedSkills:[{skillId:'s',version:'1'}],usage:null,runtimeIdentityVerified:false,streamCompleted:true,error:null,
    metadata:digest?{skillArtifactSha256:digest}:{}};
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(evidence),{headers:{'content-type':'application/json'}})));
  const right=new HttpRuntimeAdapter({adapterId:'right',endpoint:'https://fixture.invalid/execute',requireLoadedDigest:true,resolveSkill:async()=>skill});
  const left={adapterId:'left',execute:vi.fn()};
  const adapter=new SideRuntimeAdapter({left,right});
  const request={runId:'local',side:'right' as const,evalCase:pack.cases[0]!,model:{providerId:'fixture',modelId:'m',parameters:{}},variant};
  if(digest==='digest')expect((await adapter.execute(request)).metadata.skillArtifactSha256).toBe('digest');
  else await expect(adapter.execute(request)).rejects.toThrow(/digest/i);
  expect(left.execute).not.toHaveBeenCalled();
  const abort=new AbortController();abort.abort();
  await expect(adapter.execute({...request,signal:abort.signal})).rejects.toThrow();
});
