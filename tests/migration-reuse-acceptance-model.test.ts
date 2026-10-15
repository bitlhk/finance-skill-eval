import {it,expect,vi,beforeEach} from 'vitest';
const complete=vi.hoisted(()=>vi.fn());
vi.mock('../src/service/config.js',()=>({configuredModelRole:()=>({adapter:{complete},model:{providerId:'unit',modelId:'unit'}}),modelTimeoutMs:()=>10000}));
import {runReuseAcceptanceModel} from '../src/migration/infrastructure/migration-reuse-acceptance-model.js';
beforeEach(()=>{complete.mockReset();});
it('treats configured external IT fixtures as execution prerequisites, never Skill delivery or post-execution proof',async()=>{
 complete.mockResolvedValueOnce({content:JSON.stringify({status:'COVERED',reasons:[]})});
 await runReuseAcceptanceModel({mode:'COVERAGE',context:{}});
 const before=complete.mock.calls[0]![0].messages[0].content;
 expect(before).toContain('外部测试服务属于运行前提，不是迁移交付物');
 expect(before).toContain('仅写 workspaceFiles 或声称执行器自动启动服务不属于已提供资源');
 expect(before).toContain('未提供的资源、故障注入或鉴权切换能力仍是缺口');
 complete.mockResolvedValueOnce({content:JSON.stringify({checks:[{checkId:'original',status:'INDETERMINATE',reason:'Missing actual results',caseIds:['case']}]})});
 await runReuseAcceptanceModel({mode:'VERIFY',context:{}});
 const after=complete.mock.calls[1]![0].messages[0].content;
 expect(after).toContain('外部测试资源声明不是执行证据');
 expect(after).not.toContain('可作为计划的外部前提');
 expect(complete).toHaveBeenCalledTimes(2);
});
it.each(['PLAN','COVERAGE','VERIFY'] as const)('does not add universal implementation constraints during %s or relax approved ones',async mode=>{
 complete.mockResolvedValue({content:JSON.stringify(mode==='PLAN'?plan():mode==='COVERAGE'?{status:'INCOMPLETE',reasons:['Explicit requirement not covered']}:{checks:[{checkId:'original',status:'INDETERMINATE',reason:'Missing evidence',caseIds:['case']}]})});
 await runReuseAcceptanceModel({mode,context});
 const prompt=complete.mock.calls[0]![0].messages[0].content;
 expect(prompt).toContain('可选证据能力不构成新的必测项');expect(prompt).toContain('不能在测试阶段自行删除、弱化或换义');
 expect(prompt).toContain('声明的状态和宿主依赖不自动判为不复用');
 expect(prompt).toContain('重复提供业务 ID 本身不构成无状态工具或错误分支验收缺口');
 expect(prompt).toContain('toolResultInputMatches');
 expect(prompt).toContain('workspaceFiles 只挂载文件，不会启动 HTTP/MCP 服务');
 expect(prompt).toContain('COVERAGE 必须独立拒绝依赖未提供能力的计划');
 expect(prompt).not.toContain('组内每个 case 使用独立会话/工作区/业务工具进程');
 expect(complete).toHaveBeenCalledTimes(1);
});
it('separates pre-execution evidence collectability from actual post-execution proof',async()=>{
 complete.mockResolvedValueOnce({content:JSON.stringify({status:'INCOMPLETE',reasons:['Unsupported original requirement']})});
 await runReuseAcceptanceModel({mode:'COVERAGE',context:{availableRunTargets:[{toolProcessEvidence:true}]}});
 const planningPrompt=complete.mock.calls[0]![0].messages[0].content;
 expect(planningPrompt).toContain('不要求先执行才能批准计划');
 expect(planningPrompt).toContain('不能仅因此返回 INCOMPLETE');
 expect(planningPrompt).toContain('case.criteria 越界或承诺超出回执能力仍须 INCOMPLETE');
 complete.mockResolvedValueOnce({content:JSON.stringify({checks:[{checkId:'original',status:'INDETERMINATE',reason:'Missing actual receipts',caseIds:['case']}]})});
 await runReuseAcceptanceModel({mode:'VERIFY',context:{}});
 const verificationPrompt=complete.mock.calls[1]![0].messages[0].content;
 expect(verificationPrompt).toContain('都不能代替本次记录');
 expect(verificationPrompt).not.toContain('不要求先执行才能批准计划');
 expect(complete).toHaveBeenCalledTimes(2);
});
it('reports invalid fields and phase without returning model output',async()=>{
 complete.mockResolvedValue({content:JSON.stringify({checks:'PRIVATE_MODEL_OUTPUT'})});
 try{await runReuseAcceptanceModel({mode:'VERIFY',context:{}});throw new Error('must reject');}
 catch(error:any){expect(error.failure).toMatchObject({phase:'VERIFICATION',code:'MODEL_OUTPUT_INVALID',fields:['checks (invalid_type)']});expect(JSON.stringify(error.failure)).not.toContain('PRIVATE_MODEL_OUTPUT');}
 expect(complete).toHaveBeenCalledTimes(1);
});
it('guides per-check indeterminate verdicts and exposes only fixed structural diagnostics',async()=>{
 complete.mockResolvedValue({content:JSON.stringify({status:'ABSTAINED',reason:'PRIVATE_RESPONSE',PRIVATE_KEY:'secret'})});
 try{await runReuseAcceptanceModel({mode:'VERIFY',context:{}});throw new Error('must reject');}
 catch(error:any){expect(error.failure.fields).toContain('root.status (unexpected_output_shape)');expect(JSON.stringify(error.failure)).not.toMatch(/PRIVATE_RESPONSE|PRIVATE_KEY|secret/);}
 const prompt=complete.mock.calls[0]![0].messages[0].content;
 expect(prompt).toContain('不返回统一 ABSTAINED 对象');expect(prompt).toContain('对应 check 的 status 写 INDETERMINATE');
 expect(complete).toHaveBeenCalledTimes(1);
});
it('redacts provider failure while retaining model stage',async()=>{
 complete.mockRejectedValue(new Error('https://private.host/?api_key=PRIVATE_SECRET'));
 await expect(runReuseAcceptanceModel({mode:'COVERAGE',context:{}})).rejects.toMatchObject({failure:{phase:'COVERAGE',code:'MODEL_REQUEST_FAILED'}});
 try{await runReuseAcceptanceModel({mode:'PLAN',context:{}})}catch(error:any){expect(error.message).not.toContain('PRIVATE_SECRET');}
});
it('does not reinterpret incomplete coverage as PASS or retry the verdict',async()=>{
 complete.mockResolvedValue({content:JSON.stringify({status:'INCOMPLETE',reasons:['Original requirement needs actual deployment switching']})});
 expect(await runReuseAcceptanceModel({mode:'COVERAGE',context:{}})).toMatchObject({status:'INCOMPLETE'});expect(complete).toHaveBeenCalledTimes(1);
});
it('uses valid enum values in coverage and verdict JSON examples, with alternatives outside JSON',async()=>{
 complete.mockResolvedValueOnce({content:JSON.stringify({status:'INCOMPLETE',reasons:['Need evidence']})});
 await runReuseAcceptanceModel({mode:'COVERAGE',context:{}});
 const coveragePrompt=complete.mock.calls[0]![0].messages[0].content;
 expect(coveragePrompt).toContain('"status":"INCOMPLETE"');expect(coveragePrompt).not.toContain('"status":"COVERED|INCOMPLETE"');
 complete.mockResolvedValueOnce({content:JSON.stringify({checks:[{checkId:'id',status:'INDETERMINATE',reason:'Need evidence',caseIds:['case']}]})});
 await runReuseAcceptanceModel({mode:'VERIFY',context:{}});
 const verdictPrompt=complete.mock.calls[1]![0].messages[0].content;
 expect(verdictPrompt).toContain('"status":"INDETERMINATE"');expect(verdictPrompt).not.toContain('"status":"PASSED|FAILED|INDETERMINATE"');
});
const plan=(checkId='original')=>({name:'Execution',groups:[{id:'group',cases:[{id:'case',input:'Check the actual result',criteria:['Actual result']}]}],checks:[{checkId,caseIds:['case'],criteria:['Original requirement']}],unresolvedQuestions:[]});
const context={design:{scope:'Unchanged scope',acceptanceChecks:[{id:'original',purpose:'Business behavior',procedure:'Execute',expectedResult:'Actual result'}]}};
it('asks for compact plans without omitting deployment topology, turns or original requirements',async()=>{
 complete.mockResolvedValue({content:JSON.stringify(plan())});
 await runReuseAcceptanceModel({mode:'PLAN',context});
 const prompt=complete.mock.calls[0]![0].messages[0].content;
 expect(prompt).toContain('返回紧凑 JSON');expect(prompt).toContain('不能因此删减要求、跨部署运行或真实多轮');
 expect(prompt).toContain('group.runtime 的完整合法结构只有');expect(prompt).toContain('不能复制进 group.runtime');
 expect(prompt).toContain('不能证明实际进程独立');expect(prompt).toContain('不能删除要求或把静态源码冒充已观测进程行为');
 expect(complete.mock.calls[0]![0].messages[1].content).toBe(JSON.stringify(context));
 expect(complete).toHaveBeenCalledTimes(1);
});
it('re-plans one generated reference mismatch against unchanged original requirements',async()=>{
 complete.mockResolvedValueOnce({content:JSON.stringify(plan('invented'))}).mockResolvedValueOnce({content:JSON.stringify(plan())});
 expect(await runReuseAcceptanceModel({mode:'PLAN',context})).toEqual(plan());expect(complete).toHaveBeenCalledTimes(2);
 const repair=complete.mock.calls[1]![0];expect(repair.toolFree).toBe(true);expect(repair.requestId).toContain('references-1');
 expect(repair.messages[1].content).toBe(JSON.stringify(context));expect(repair.messages.at(-1).content).toContain('validationErrors');
});
it('stops after one re-planning attempt and never relabels invented requirements itself',async()=>{
 complete.mockResolvedValue({content:JSON.stringify(plan('invented'))});
 await expect(runReuseAcceptanceModel({mode:'PLAN',context})).rejects.toMatchObject({failure:{phase:'PLAN',code:'MODEL_PLAN_REFERENCE_INVALID'}});expect(complete).toHaveBeenCalledTimes(2);
});
it('replans omitted selected deployment references once without silently cloning or deselecting targets',async()=>{
 const targets=[{environmentId:'primary',modelId:'m'},{environmentId:'additional',modelId:'m'}];
 const initial=plan(),fixed={...plan(),groups:[...initial.groups,{id:'other',runtime:targets[1],cases:[{id:'other-case',input:'Check actual result',criteria:['Actual result']}]}],checks:[{...initial.checks[0]!,caseIds:['case','other-case']}]};
 complete.mockResolvedValueOnce({content:JSON.stringify(initial)}).mockResolvedValueOnce({content:JSON.stringify(fixed)});
 await expect(runReuseAcceptanceModel({mode:'PLAN',context:{...context,availableRunTargets:targets}})).resolves.toEqual(fixed);
 expect(complete).toHaveBeenCalledTimes(2);
 expect(complete.mock.calls[1]![0].messages.at(-1).content).toContain('additional');
});
it('rejects repeated omitted or unselected targets after the one planning correction',async()=>{
 complete.mockResolvedValue({content:JSON.stringify(plan())});
 await expect(runReuseAcceptanceModel({mode:'PLAN',context:{...context,availableRunTargets:[{environmentId:'primary',modelId:'m'},{environmentId:'additional',modelId:'m'}]}})).rejects.toMatchObject({failure:{code:'MODEL_PLAN_REFERENCE_INVALID'}});
 expect(complete).toHaveBeenCalledTimes(2);
});
it('retains genuine unresolved requirements rather than retrying them away',async()=>{
 const unresolved={...plan(),unresolvedQuestions:['Original requirement needs a new deployment']};complete.mockResolvedValue({content:JSON.stringify(unresolved)});
 expect(await runReuseAcceptanceModel({mode:'PLAN',context})).toEqual(unresolved);expect(complete).toHaveBeenCalledTimes(1);
});
it('preserves a single unresolved question represented as a string',async()=>{
 complete.mockResolvedValue({content:JSON.stringify({...plan(),unresolvedQuestions:'Needs an unsupported deployment'})});
 expect(await runReuseAcceptanceModel({mode:'PLAN',context})).toEqual({...plan(),unresolvedQuestions:['Needs an unsupported deployment']});
 expect(complete).toHaveBeenCalledTimes(1);
});
it('normalizes an explicitly empty question string without inventing checks or approval',async()=>{
 complete.mockResolvedValue({content:JSON.stringify({...plan(),unresolvedQuestions:''})});
 expect(await runReuseAcceptanceModel({mode:'PLAN',context})).toEqual(plan());expect(complete).toHaveBeenCalledTimes(1);
});
it.each([null,{},undefined])('does not treat an unknown/missing question list as no gaps (%j)',async unresolvedQuestions=>{
 complete.mockResolvedValue({content:JSON.stringify({...plan(),unresolvedQuestions})});
 await expect(runReuseAcceptanceModel({mode:'PLAN',context})).rejects.toMatchObject({failure:{code:'MODEL_OUTPUT_INVALID'}});
 expect(complete).toHaveBeenCalledTimes(1);
});
it('does not normalize a malformed substantive criteria list',async()=>{
 const invalid=plan();(invalid.checks[0] as any).criteria='Original requirement';
 complete.mockResolvedValue({content:JSON.stringify(invalid)});
 await expect(runReuseAcceptanceModel({mode:'PLAN',context})).rejects.toMatchObject({failure:{code:'MODEL_OUTPUT_INVALID'}});
 expect(complete).toHaveBeenCalledTimes(1);
});
it('never regenerates a business verdict because references are incorrect',async()=>{
 const verdict={checks:[{checkId:'invented',status:'PASSED',reason:'A claim',caseIds:['case']}]};complete.mockResolvedValue({content:JSON.stringify(verdict)});
 expect(await runReuseAcceptanceModel({mode:'VERIFY',context})).toEqual(verdict);expect(complete).toHaveBeenCalledTimes(1);
});
it('does not silently truncate source or exceed the input budget when re-planning',async()=>{
 complete.mockResolvedValue({content:JSON.stringify(plan('invented'))});
 const large={...context,source:'x'.repeat(599_700)};
 await expect(runReuseAcceptanceModel({mode:'PLAN',context:large})).rejects.toMatchObject({failure:{phase:'PLAN',code:'INPUT_TOO_LARGE'}});expect(complete).toHaveBeenCalledTimes(1);
});
it('guides static condition checks into original check ids without inventing dynamic evidence',async()=>{
 complete.mockResolvedValue({content:JSON.stringify(plan())});await runReuseAcceptanceModel({mode:'PLAN',context});
 const instruction=complete.mock.calls[0]![0].messages[0].content;
 expect(instruction).toContain('相关原 check 的 checks.criteria');expect(instruction).toContain('candidateBinaryPaths');
 expect(instruction).toContain('不能凭空断言已测量运行环境');expect(complete).toHaveBeenCalledTimes(1);
});
