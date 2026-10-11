import {createServer} from 'node:http';
import {expect,it} from 'vitest';
import {planMigrationImprovement} from '../src/migration/infrastructure/migration-improvement-planner.js';

const hypothesis={layer:'TOOL',issue:'业务工具返回错误',expectedBehavior:'返回有效结果',evidenceCaseIds:['dev-1'],
  validation:'重跑开发案例',risk:'外部服务可能仍不可用',confidence:'low'};
const input={modelId:'test',sourceJobId:'job-1',baseSolutionRevisionId:'revision-1',tools:[],runtimeConfiguration:[],
  technicalEvidence:[],cases:[{caseId:'dev-1',task:'查询',runtimeStatus:'completed',runtimeIdentityVerified:true,
    streamCompleted:true,toolTraceStatus:'COMPLETE' as const,toolCalls:[],review:null,verdict:'FAIL'}]};

async function serve(outputs:string[],run:(url:string,requests:Array<{tools?:unknown;messages?:Array<{content:string}>}>)=>Promise<void>,withToolDefaults=false){
  const requests:Array<{tools?:unknown;messages?:Array<{content:string}>}>=[];
  const server=createServer(async(req,res)=>{
    let body='';for await(const part of req)body+=String(part);
    requests.push(JSON.parse(body) as {tools?:unknown});
    const content=outputs[requests.length-1];
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({choices:[{message:{content}}],model:'test'}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address||typeof address==='string')throw Error('test server port unavailable');
  const keys=['FINANCE_EVAL_OPTIMIZER_BASE_URL','FINANCE_EVAL_OPTIMIZER_API_KEY','FINANCE_EVAL_OPTIMIZER_MODEL',
    'FINANCE_EVAL_OPTIMIZER_REQUEST_DEFAULTS'] as const;
  const previous=keys.map(key=>process.env[key]);
  try{
    process.env[keys[0]]=`http://127.0.0.1:${address.port}`;
    process.env[keys[1]]='test';process.env[keys[2]]='test-model';
    if(withToolDefaults)process.env[keys[3]]=JSON.stringify({tools:[{type:'function',function:{name:'unsafe',parameters:{type:'object'}}}],tool_choice:'auto'});
    else delete process.env[keys[3]];
    await run(process.env[keys[0]],requests);
  }finally{
    for(const [i,key] of keys.entries())if(previous[i]===undefined)delete process.env[key];else process.env[key]=previous[i];
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
}

it('normalizes an unambiguous enum representation without another model call',async()=>{
  await serve([JSON.stringify({status:'PROPOSED',hypothesis})],async(_url,requests)=>{
    const result=await planMigrationImprovement(input);
    expect(result).toMatchObject({judgement:{status:'PROPOSED',hypothesis:{confidence:'LOW'}},outputCorrection:{attempts:0}});
    expect(requests).toHaveLength(1);
    const prompt=requests[0]?.messages?.[0]?.content;
    expect(prompt).toContain('已发布的 Builder JSON Schema');expect(prompt).toContain('"required":["inputSchema","outputSchema","errorSchema","semantics"]');
  });
});
it('reports safe invalid field categories without retaining arbitrary model values',async()=>{
  const invalid=JSON.stringify({status:'PROPOSED',hypothesis:{...hypothesis,layer:'PRIVATE_MODEL_VALUE'}});
  await serve([invalid,invalid,invalid],async()=>{
    const error=await planMigrationImprovement(input).catch(error=>error);
    expect(error.message).toContain('MODEL_OUTPUT_INVALID');expect(error.fields).toContain('hypothesis.layer (invalid_enum_value)');
    expect(error.message).not.toContain('PRIVATE_MODEL_VALUE');
  });
});

it('repairs an extra output field while preserving the model hypothesis',async()=>{
  await serve([JSON.stringify({status:'PROPOSED',hypothesis,commentary:'extra'}),
    JSON.stringify({status:'PROPOSED',hypothesis:{...hypothesis,confidence:'LOW'}})],async(_url,requests)=>{
    const result=await planMigrationImprovement(input);
    expect(result).toMatchObject({judgement:{status:'PROPOSED',hypothesis:{issue:hypothesis.issue,confidence:'LOW'}},
      outputCorrection:{attempts:1}});
    expect(requests).toHaveLength(2);
    expect(requests[0]?.tools).toBeDefined();
    expect(requests[1]?.tools).toBeUndefined();
  },true);
});

it('does not allow format repair to add an absent substantive claim',async()=>{
  const {risk,...withoutRisk}=hypothesis;
  await serve([JSON.stringify({status:'PROPOSED',hypothesis:withoutRisk}),
    JSON.stringify({status:'PROPOSED',hypothesis:{...withoutRisk,risk}})],async()=>{
    await expect(planMigrationImprovement(input)).rejects.toThrow('改变了原始判断或证据');
  });
});

it('allows the model to abstain when the original proposal lacks a necessary fact',async()=>{
  const {risk:unused,...withoutRisk}=hypothesis;
  void unused;
  await serve([JSON.stringify({status:'PROPOSED',hypothesis:withoutRisk}),
    JSON.stringify({status:'ABSTAINED',reason:'无法从原结果确认风险'})],async()=>{
    const result=await planMigrationImprovement(input);
    expect(result).toMatchObject({judgement:{status:'ABSTAINED'},outputCorrection:{attempts:1}});
  });
});
