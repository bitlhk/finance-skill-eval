import http from 'node:http';
import { expect, it } from 'vitest';
import { HttpRuntimeAdapter } from '../src/http-runtime.js';
import { SideRuntimeAdapter } from '../src/side-runtime.js';
import { loadEvalPack } from '../src/eval-pack.js';

it('uses independent side payloads over real HTTP and cancels the in-flight connection',async()=>{
  const calls:Array<{url:string;body:any}>=[];
  let entered!:()=>void, closed!:()=>void;
  const waiting=new Promise<void>(r=>entered=r), cancelled=new Promise<void>(r=>closed=r);
  const server=http.createServer(async(req,res)=>{
    if(req.method==='GET'){res.end('{}');return;}
    const chunks=[];for await(const c of req)chunks.push(c);
    const body=JSON.parse(Buffer.concat(chunks).toString());calls.push({url:req.url!,body});
    if(body.case.prompt==='cancel-me'){res.on('close',closed);entered();return;}
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({runId:body.runId,caseId:body.case.caseId,side:body.side,status:'completed',
      modelId:body.model.modelId,skillVersion:body.skill.version,output:'Synthetic HTTP protocol result',elapsedMs:1,
      toolCalls:[],loadedSkills:[{skillId:body.skill.skillId,version:body.skill.version}],usage:null,
      runtimeIdentityVerified:false,streamCompleted:true,error:null,metadata:{skillArtifactSha256:body.skill.artifactSha256}}));
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const port=(server.address() as {port:number}).port;
  const make=(side:string,version:string)=>new HttpRuntimeAdapter({adapterId:side,endpoint:`http://127.0.0.1:${port}/${side}/execute`,
    requireLoadedDigest:true,resolveSkill:async()=>({skillId:'method',version,artifactSha256:'digest-'+version,instructions:'Version '+version,files:{'SKILL.md':'Version '+version}})});
  const runtime=new SideRuntimeAdapter({left:make('left','1'),right:make('right','2')});
  try {
    const pack=await loadEvalPack('packs/finance/investment-research/eval.yaml');
    await runtime.prepare();
    const request={runId:'test-run',evalCase:pack.cases[0]!,model:{providerId:'fixture',modelId:'same-model',parameters:{}}};
    for(const side of ['left','right'] as const){
      const version=side==='left'?'1':'2';
      const result=await runtime.execute({...request,side,variant:{mode:'skill_version',skillId:'method',version}});
      expect(result.runtimeIdentityVerified).toBe(false);
    }
    expect(calls.map(c=>[c.url,c.body.skill.version])).toEqual([['/left/execute','1'],['/right/execute','2']]);
    expect(calls[0]!.body.model).toEqual(calls[1]!.body.model);
    const controller=new AbortController();
    const execution=runtime.execute({...request,side:'left',variant:{mode:'skill_version',skillId:'method',version:'1'},
      evalCase:{...request.evalCase,prompt:'cancel-me'},signal:controller.signal});
    const rejection=expect(execution).rejects.toThrow();
    await waiting;controller.abort();await rejection;await cancelled;
    expect(calls).toHaveLength(3);
  } finally {await runtime.cleanup();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
