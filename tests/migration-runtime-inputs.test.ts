import {expect,it} from 'vitest';
import {configurationSchema,type BundleAnalysis} from '../src/migration/tasks/domain/task-model.js';
import {runtimeInputIssues,resolveRuntimeInputs,runtimeInputValuesSchema} from '../src/migration/tasks/domain/task-runtime-inputs.js';
import {sameConfiguration} from '../web/src/features/migration/presentation.js';
import {reviewPlanEnvironment} from '../src/migration/tasks/domain/task-runtime-review.js';
const analysis={standardization:{configurationInputs:[
  {name:'MEETINGROOM_BASE_URL',label:'会议室测试服务地址',description:'用户提供测试服务',required:true,sensitive:false,toolIds:['meeting']},
  {name:'MODEL_API_KEY',label:'模型凭证',description:'环境配置引用',required:false,sensitive:true,toolIds:['image']},
]}} as unknown as BundleAnalysis;
const base={environmentId:'env',modelId:'model',timeoutMs:10000,harnessTools:[]};
it('allows saving incomplete configuration but blocks execution with precise missing fields',()=>{
 const configuration=configurationSchema.parse(base);
 expect(runtimeInputIssues({analysis},configuration)).toEqual([]);
 expect(runtimeInputIssues({analysis},configuration,true)).toEqual(['请补充会议室测试服务地址（MEETINGROOM_BASE_URL）']);
});
it('rejects undeclared config, credentials in plain fields and host execution overrides',()=>{
 const c=configurationSchema.parse({...base,runtimeInputs:{UNKNOWN:{value:'x'},MODEL_API_KEY:{value:'do-not-store'}}});
 expect(runtimeInputIssues({analysis},c).join()).toContain('不在当前方案');
 expect(runtimeInputIssues({analysis},c).join()).toContain('安全配置引用');
 for(const key of ['PATH','PYTHONPATH','FINANCE_RUNTIME_CONFIG','NODE_OPTIONS'])expect(runtimeInputValuesSchema.safeParse({[key]:{value:'x'}}).success).toBe(false);
});
it('resolves references for execution without writing secrets back to saved configuration',()=>{
 const c=configurationSchema.parse({...base,runtimeInputs:{MEETINGROOM_BASE_URL:{value:'http://localhost:19000'},MODEL_API_KEY:{secretEnv:'TEST_MODEL_KEY'}}});
 const before=JSON.stringify(c);
 expect(runtimeInputIssues({analysis},c,true)).toEqual([]);
 const resolved=resolveRuntimeInputs(c,{TEST_MODEL_KEY:'private-value'});
 expect(resolved.publicValues).toEqual({'tool.env.MEETINGROOM_BASE_URL':'http://localhost:19000'});
 expect(resolved.secrets).toEqual({'tool.env.MODEL_API_KEY':'private-value'});
 expect(JSON.stringify(c)).toBe(before);expect(before).not.toContain('private-value');
 expect(()=>resolveRuntimeInputs(c,{})).toThrow('配置凭证引用');
});
it('accepts a complete fallback group but rejects mixing incomplete alternatives',()=>{
 const fields=['PRIMARY_URL','PRIMARY_KEY','FALLBACK_URL','FALLBACK_KEY'].map(name=>({name,label:name,description:name,required:false,sensitive:name.endsWith('KEY'),toolIds:['image']}));
 const task={analysis:{standardization:{configurationInputs:fields,configurationGroups:[{label:'模型连接',alternatives:[['PRIMARY_URL','PRIMARY_KEY'],['FALLBACK_URL','FALLBACK_KEY']]}]}}};
 const values={FALLBACK_URL:{value:'https://example.test/v1'},FALLBACK_KEY:{secretEnv:'MODEL_KEY'}};
 expect(runtimeInputIssues(task,{runtimeInputs:values},true)).toEqual([]);
 expect(runtimeInputIssues(task,{runtimeInputs:{PRIMARY_URL:{value:'https://example.test/v1'},FALLBACK_KEY:values.FALLBACK_KEY}},true).join()).toContain('任选一组');
 expect(runtimeInputIssues(task,{},false)).toEqual([]);
});
it('recognizes saved configuration after schema key reordering without ignoring nested edits',()=>{
 const before={...base,runtimeInputs:{MODEL_API_KEY:{secretEnv:'KEY_A'},MEETINGROOM_BASE_URL:{value:'https://example.test'}}};
 const saved=configurationSchema.parse(before);
 expect(Object.keys(before)).not.toEqual(Object.keys(saved));
 expect(sameConfiguration(before,saved)).toBe(true);
 expect(sameConfiguration(before,{...saved,runtimeInputs:{...saved.runtimeInputs,MODEL_API_KEY:{secretEnv:'KEY_B'}}})).toBe(false);
});
it('environment review distinguishes unused alternatives from incomplete groups',()=>{
 const task={currentCandidateId:'candidate',configuration:{...base,runtimeInputs:{FALLBACK_URL:{value:'https://example.test'}}},analysis:{
   plan:{requiredCapabilities:[],dependencies:[],conditions:[]},standardization:{
     configurationInputs:['PRIMARY_URL','FALLBACK_URL'].map(name=>({name,label:name,description:name,required:false,sensitive:false,toolIds:['tool']})),
     configurationGroups:[{label:'服务地址',alternatives:[['PRIMARY_URL'],['FALLBACK_URL']]}]}}};
 const review=reviewPlanEnvironment(task as never,{});
 expect(review.items.find(i=>i.name==='PRIMARY_URL')?.reason).toContain('无需重复提供');
 expect(review.status).toBe('INCOMPLETE');
 expect(reviewPlanEnvironment({...task,configuration:base} as never,{}).status).toBe('FAILED');
});
