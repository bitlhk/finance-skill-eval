// Controlled migration fixtures: exercise contracts and UI without claiming business-model acceptance.
export const readerCapability={capabilityId:'workspace.reader',name:'read_file',
  contract:{inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path']},outputSchema:{type:'string'},errorSchema:{type:'object'},semantics:'Read a relative file in the current instance workspace'},
  constraints:{permissions:['workspace.read'],sideEffects:'read',isolation:'per_runtime_instance'}};
export function fixtureAnalysis(input){
  const member=input.base.members[0],path=member.skillFile;
  const snippet=Buffer.from(input.base.files[path],'base64').toString('utf8').split('\n').find(line=>line.startsWith('description:'));
  const evidence=[{path,snippet}];
  return {summary:'保留原有业务规则，统一共享配置读取，并逐项验证原有结果。',changes:[{paths:['shared/rules.json'],reason:'明确共享金额单位'}],missing:[],diagnosis:{
    skillChanges:input.base.members.map(m=>({memberIds:[m.id],paths:[m.skillFile],action:'KEEP',reason:'保留原有入口、参数说明和业务责任。'})),
    tools:[{id:'reader',name:'工程规则读取',memberIds:[],sourcePaths:[path],currentBehavior:'各成员按相对路径读取共享金额规则。',problem:'原规则使用分，调用方要求统一使用元。',targetForm:'KEEP',language:'现有工程',reason:'保留读取方式，只统一共享金额单位。',
      changes:[{title:'统一金额单位',before:'共享规则使用 cents。',after:'共享规则使用 yuan，成员继续读取同一配置。',steps:['修改共享金额单位配置。','核对全部成员的配置读取路径。']}],
      preservedBehavior:['保留原有业务拒绝条件。'],callChain:[{title:'读取共享配置',detail:'成员通过工程相对路径获取规则。',evidence}],evidence}],
    dependencies:[{id:'reader-dep',name:'工程文件读取',toolIds:['reader'],owner:'RUNTIME',action:'INJECT',purpose:'读取当前工程中的共享规则。',configuration:'由运行环境提供 read_file 能力。',verification:'核对接口和权限后执行真实读取测试。',evidence}],
  },plan:{
    scope:`迁移整个工程的 ${input.base.members.length} 个 Skill，统一处理共享配置；所有成员入口与业务责任保持不变。`,
    preservedBehavior:['保留原有输入参数、金额单位与拒绝条件。','保留各 Skill 的相对资源路径和组合调用关系。'],
    sourceCouplings:[{description:'各成员读取同一份工程规则文件。',memberIds:[],evidence}],
    changes:[{id:'shared-config',title:'统一共享规则配置',implementation:'将共享规则的金额单位明确为元。\n\n各成员继续使用原有相对路径，避免重复维护配置。'+(input.clarification?'\n\n补充要求：'+input.clarification:''),toolNames:[],memberIds:[],evidence},
      {id:'member-entry',title:'保留成员入口和调用方式',implementation:'保留 SKILL.md 的名称、说明与正文，核对资源路径。',toolNames:[],memberIds:input.base.members.map(m=>m.id),evidence}],
    dependencies:[{key:'workspace.reader',name:'工程文件读取',contract:readerCapability.contract.semantics,configuration:'由执行环境提供；按相对路径读取当前工程。',memberIds:[]}],conditions:[],unresolvedQuestions:[],
    acceptanceChecks:[{id:'combined-result',purpose:'验证原有业务结果',requirement:'原业务行为保持一致',procedure:'读取工程规则，完成各成员负责的任务，并报告实际执行结果。',expectedResult:'BUSINESS_OK',memberIds:input.base.members.map(m=>m.id)}],
    requiredCapabilities:[{id:'workspace.reader',name:'read_file',required:true,reason:'读取共享规则',contract:readerCapability.contract,constraints:readerCapability.constraints,preferredTargetCapability:'workspace.reader',consumerTools:[],evidence:[{path,line:1,detail:'Shared project input'}]}]
  }};
}
export async function fixtureAgent(input){
  if(input.mode==='ANALYZE')return {status:'PRODUCED',analysis:fixtureAnalysis(input)};
  return {status:'PRODUCED',files:{...input.base.files,'shared/rules.json':Buffer.from('{"unit":"yuan"}').toString('base64')},delivery:{summary:'### 已完成的改造\n\n- 共享规则明确使用元。\n- 保留所有 Skill 入口和相对路径。\n\n### 仍需验证\n\n环境能力、实际工具调用与业务结果。',services:[]}};
}
