import {afterEach,it,expect} from 'vitest';
import {createServer,type Server} from 'node:http';
import {OriginalServiceRuntimeAdapter,originalServiceSchema} from '../src/original-service-runtime.js';
import {ModelServiceComparisonJudge} from '../src/service-comparison-judge.js';
import {runtimeExecutionEvidenceSchema} from '../src/contracts.js';
import {runConfigurationSchema} from '../src/service/contracts.js';
import {simpleMigrationCases,simpleMigrationSuiteSchema} from '../src/migration/domain/simple-migration-suite.js';
import {MigrationAssessmentStep} from '../web/src/MigrationAssessmentStep.js';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import {EvaluationRunManager} from '../src/service/run-manager.js';
import {renderHtmlReport} from '../src/report.js';
const servers:Server[]=[];const saved=process.env.COMPARISON_TEST_TOKEN;
afterEach(async()=>{await Promise.all(servers.splice(0).map(server=>new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections()})));if(saved===undefined)delete process.env.COMPARISON_TEST_TOKEN;else process.env.COMPARISON_TEST_TOKEN=saved});
async function service(handler:Parameters<typeof createServer>[0]){const server=createServer(handler);servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${(server.address() as {port:number}).port}/run`}
const model={providerId:'test',modelId:'test',parameters:{}};
const definition=simpleMigrationCases(simpleMigrationSuiteSchema.parse({name:'余额',cases:[{id:'a',input:'查询 A1 "余额"',criteria:['余额为1000元']}]}))[0]!;
const request={runId:'run',side:'left' as const,evalCase:definition,model,variant:{mode:'skill_version' as const,skillId:'skill',version:'1',artifactSha256:'a'.repeat(64)}};
const right=runtimeExecutionEvidenceSchema.parse({runId:'run',side:'right',caseId:'a',modelId:'test',skillVersion:'2',status:'completed',output:'余额为 1000 元',elapsedMs:1,streamCompleted:true,runtimeIdentityVerified:true,error:null});
it('calls a real original HTTP service with its own nested request and response formats, without claiming original Runtime identity',async()=>{
 process.env.COMPARISON_TEST_TOKEN='test-service-secret';let body:any,authorization:string|undefined;
 const endpoint=await service(async(req,res)=>{authorization=req.headers.authorization;let text='';for await(const chunk of req)text+=chunk;body=JSON.parse(text);res.setHeader('content-type','application/json');res.end(JSON.stringify({data:{answer:'余额为1000元'}}))});
 const adapter=new OriginalServiceRuntimeAdapter(originalServiceSchema.parse({endpoint,requestTemplate:{request:{message:'{{input}}'},case:'{{caseId}}'},responsePointer:'/data/answer',headers:[{name:'Authorization',env:'COMPARISON_TEST_TOKEN',prefix:'Bearer '}]}),'a'.repeat(64));
 const result=await adapter.execute(request);expect(result.status).toBe('completed');expect(result.output).toBe('余额为1000元');expect(body).toEqual({request:{message:definition.prompt},case:'a'});expect(JSON.stringify(body)).not.toContain('criteria');expect(authorization).toBe('Bearer test-service-secret');expect(result.loadedSkills).toEqual([]);expect(result.runtimeIdentityVerified).toBe(false);expect(JSON.stringify(result)).not.toContain('test-service-secret');
});
it('reports HTTP, missing mapping and timeout failures instead of using a false baseline; redacts echoed credentials',async()=>{
 const endpoint=await service((req,res)=>{if(req.url==='/failure'){res.statusCode=403;res.end('private-secret');return}if(req.url==='/slow'){setTimeout(()=>res.end('{}'),1500);return}res.end('{"answer":"echo: test-service-secret"}')});
 const make=(extra:any)=>new OriginalServiceRuntimeAdapter(originalServiceSchema.parse({endpoint,requestTemplate:{task:'{{input}}'},...extra}),'a'.repeat(64));
 expect((await make({endpoint:endpoint.replace('/run','/failure')}).execute(request)).error).toBe('原服务调用失败：HTTP 403');
 expect((await make({responsePointer:'/unknown'}).execute(request)).status).toBe('failed');
 expect((await make({endpoint:endpoint.replace('/run','/slow'),timeoutMs:1000}).execute(request)).error).toBe('原服务调用超时');
 process.env.COMPARISON_TEST_TOKEN='test-service-secret';expect((await make({headers:[{name:'Authorization',env:'COMPARISON_TEST_TOKEN'}]}).execute(request)).output).not.toContain('test-service-secret');
 const abort=new AbortController();abort.abort();await expect(make({}).execute({...request,signal:abort.signal})).rejects.toThrow();
});
it('uses grounded quotes from both sides, rejects fabricated or missing PASS evidence, and separates execution failure',async()=>{
 const left={...right,side:'left' as const,output:'{"balance":1000}'};
 const checks=[{criterionIndex:0,verdict:'PASS',reason:'两侧余额一致且满足要求',originalEvidence:'1000',candidateEvidence:'1000'}];
 const judge=(items:any[])=>new ModelServiceComparisonJudge({adapterId:'test',complete:async()=>({modelId:'test',content:JSON.stringify({checks:items})})},model);
 const input={evalCase:definition,left,right,profile:{} as any};
 expect((await judge(checks).compare(input)).serviceComparison?.verdict).toBe('PASS');
 for(const change of [{originalEvidence:'伪造'},{candidateEvidence:'伪造'},{originalEvidence:''}])await expect(judge([{...checks[0],...change}]).compare(input)).rejects.toThrow();
 await expect(judge(checks).compare({...input,left:{...left,status:'failed'}})).rejects.toThrow('执行失败');
 expect((await judge([{...checks[0],verdict:'INDETERMINATE',originalEvidence:'',candidateEvidence:''}]).compare(input)).serviceComparison?.verdict).toBe('INDETERMINATE');
});
it('routes baseline calls to the original service and candidate calls only to the right Runtime',async()=>{
 const endpoint=await service((req,res)=>res.end('{"answer":"1000"}'));const sides:string[]=[];
 const manager=new EvaluationRunManager({environments:{headers:()=>({})},resolveMigrationRuntime:async()=>({environmentId:'right',type:'runtime_launcher',baseUrl:'http://127.0.0.1:1/',runtimeType:'openjiuwen'}),skills:{list:async()=>[{assetId:'candidate',skillId:'skill',version:'2',artifactSha256:'b'.repeat(64),skillFile:'SKILL.md'}],readArchive:async()=>({'SKILL.md':Buffer.from('skill')}),readFiles:async()=>({}),readSource:async()=>'skill'}} as any);
 const configuration={evaluationMode:'service_comparison',runtimeBindings:{left:{environmentId:'unused',skillAssetId:'source'},right:{environmentId:'right',skillAssetId:'candidate'}},originalService:originalServiceSchema.parse({endpoint,requestTemplate:{task:'{{input}}'},responsePointer:'/answer'}),timeoutMs:10000};
 const pack={variants:{left:request.variant,right:{...request.variant,version:'2',artifactSha256:'b'.repeat(64)}},models:{execution:{left:model,right:model}},cases:[definition],metadata:{assessmentMode:'natural_language'}};
 const runtime=await (manager as any).runtimeFor(configuration,pack);
 const result=await runtime.execute(request);expect(result.output).toBe('1000');expect(runtime.adapterId).toContain('original-service');
});
it('identifies the invalid quote on retry without accepting concatenated or rewritten evidence',async()=>{
 const requests:any[]=[];
 const judge=new ModelServiceComparisonJudge({adapterId:'retry',complete:async request=>{requests.push(request);return {modelId:'test',content:JSON.stringify({checks:[{criterionIndex:0,verdict:'PASS',reason:'余额相同',originalEvidence:'1000',candidateEvidence:requests.length===1?'余额为1000元':'1000'}]})}}},model);
 expect((await judge.compare({evalCase:definition,left:{...right,side:'left',output:'{"balance":1000}'},right,profile:{} as any})).serviceComparison?.verdict).toBe('PASS');
 expect(JSON.parse(requests[1].messages[1].content).previousResponseError).toContain('余额为1000元');
 expect(JSON.parse(requests[1].messages[1].content).previousResponseError).toContain('不要改写或拼接');
});
it('shows the two choices before configuration and shows request/response mapping only in comparison mode',()=>{
 const props={api:async()=>({} as any),projectId:'project',suites:[],experiments:[],busy:false,refresh:async()=>{},runtimeId:'launcher',setRuntimeId:()=>{},runtimes:[{runtimeId:'launcher',name:'Runtime Launcher',runtimeType:'openjiuwen' as const,endpoint:'http://127.0.0.1:56362/',transport:'runtime_launcher' as const,defaultModelId:'execution-model',models:[{providerId:'internal-provider-id',modelId:'execution-model',label:'企业执行模型',upstreamModelId:'deepseek-v4-flash'}]}],modelKey:'execution-model',setModelKey:()=>{},packId:'',setPackId:()=>{},run:()=>{},next:()=>{}};
 const initial=renderToStaticMarkup(createElement(MigrationAssessmentStep,props));expect(initial).toContain('提供测试集和目标');expect(initial).toContain('接入原服务做对比');expect(initial).not.toContain('请求 JSON 模板');expect(initial).not.toContain('选择 JSON 测试集');
 const comparison=renderToStaticMarkup(createElement(MigrationAssessmentStep,{...props,initialMode:'service'}));expect(comparison).toContain('请求 JSON 模板');expect(comparison).toContain('/data/answer');expect(comparison).toContain('AI 生成');expect(comparison).toContain('deepseek-v4-flash');expect(comparison).not.toContain('internal-provider-id');
 expect(()=>originalServiceSchema.parse({endpoint:'http://localhost',requestTemplate:{task:'static'}})).toThrow();
});
it('shows assessment history newest first and keeps result details collapsible',()=>{
 const base={api:async()=>({} as any),projectId:'project',candidateDigest:'candidate',suites:[],busy:false,refresh:async()=>{},runtimeId:'',setRuntimeId:()=>{},runtimes:[],modelKey:'',setModelKey:()=>{},packId:'',setPackId:()=>{},run:()=>{},next:()=>{},initialMode:'goals' as const};
 const experiments=[
  {jobId:'older',candidateDigest:'candidate',execution:'failed',createdAt:'2026-09-18T00:00:00.000Z',report:null,error:{message:'older-result'}},
  {jobId:'newer',candidateDigest:'candidate',execution:'failed',createdAt:'2026-09-19T00:00:00.000Z',report:null,error:{message:'newer-result'}},
 ];
 const html=renderToStaticMarkup(createElement(MigrationAssessmentStep,{...base,experiments}));
 expect(html.indexOf('newer-result')).toBeLessThan(html.indexOf('older-result'));expect(html).toContain('<details class="migration-result" open="">');
 expect(html).not.toContain('不读取“测试环境”');expect(html).not.toContain('Judge');
});
it('exports two-side answers and grounded comparison results without misleading win scores',()=>{
 const html=renderHtmlReport({pack:{targetSkillId:'test',packId:'pack',version:'1'},variants:{left:request.variant,right:request.variant},summary:{headline:'原服务对比',leftWins:0,rightWins:0,ties:1},cases:[{caseId:'a',name:'余额',prompt:'查询',evaluationGoal:'余额正确',left:{...right,side:'left',metadata:{baselineService:{}}},right,judge:{serviceComparison:{verdict:'PASS',reason:'一致',checks:[{criterion:'余额',verdict:'PASS',reason:'相同',originalEvidence:'1000',candidateEvidence:'1000'}]},dimensions:[]}}]} as any);
 expect(html).toContain('原服务依据');expect(html).toContain('迁移后依据');expect(html).toContain('源资产关联');expect(html).not.toContain('左侧胜出');expect(html).not.toContain('右侧胜出');
});
