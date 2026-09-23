import {expect,it} from 'vitest';
import {toProjectInspection} from '../src/migration/infrastructure/migration-agent.js';
import {buildMigrationPlan,stableToolId} from '../src/migration/domain/migration-model.js';
import {analyzeDependencies} from '../src/migration/infrastructure/migration-dependencies.js';

const source='Runtime harness provides read_file(path) for workspace files.\nBusiness lookup uses read_file to read a local report.\n';
const files={'SKILL.md':source};
const harness={name:'read_file',reason:'Runtime 通用文件读取，不建议与 Skill 绑定',usageContract:'path 相对工作区；返回文本；权限及错误待确认',
 consumerTools:['lookup'],evidence:[{path:'SKILL.md',snippet:source.split('\n')[0]!}]};
const tool={name:'read_file',sourcePaths:['SKILL.md'],portability:'RUNTIME_BOUND'};

it('retains verified harness requirements for the dedicated Runtime adaptation stage',()=>{
 const payload={tools:[tool],runtimeCapabilities:[harness],dependencyAnalysis:{dependencies:[],chains:[]}};
 const inspection=toProjectInspection(payload,'asset','digest',stableToolId,null,files);
 inspection.dependencyAnalysis=analyzeDependencies(payload,inspection,files,[],0,'digest');
 expect(inspection.tools).toEqual([]);
 expect(inspection.runtimeCapabilities?.[0]).toMatchObject({owner:'RUNTIME_HARNESS',migrationAction:'REQUIRES_RUNTIME_BUILDER',blocking:true,
  testAvailability:'UNCHECKED',targetCapability:null,consumerTools:['lookup'],evidence:[{path:'SKILL.md',line:1}]});
 expect(inspection.dependencyAnalysis.status).toBe('COMPLETE');
 expect(buildMigrationPlan(inspection,[],'asset')).toMatchObject({generationAllowed:true,technicalValidationAllowed:false});
});

it('ignores harness implementation dependencies and chains without reporting rejected source claims',()=>{
 const dependency={key:'python:pathlib:Path',name:'pathlib',kind:'SDK',owner:'TOOL',action:'KEEP',contractStatus:'KNOWN',
  sensitive:false,purpose:'Runtime 文件读取实现使用 Python 标准库',blocking:false,availability:'AVAILABLE',
  references:[{toolName:'read_file',path:'SKILL.md',snippet:source.split('\n')[0]!}],resolvedPaths:[]};
 const payload={tools:[tool],runtimeCapabilities:[harness],dependencyAnalysis:{dependencies:[dependency],chains:[{
  toolName:'read_file',nodes:[{id:'read',title:'读取文件',detail:'Runtime Harness 读取工作区文件',dependencyKeys:[dependency.key],
   evidence:[{path:'SKILL.md',snippet:source.split('\n')[0]!}]}],edges:[]}]}};
 const inspection=toProjectInspection(payload,'asset','digest',stableToolId,null,files);
 const analysis=analyzeDependencies(payload,inspection,files,[],0,'digest');
 expect(analysis).toMatchObject({status:'COMPLETE',dependencies:[],chains:[],rejectedClaims:0});
 expect(buildMigrationPlan({...inspection,dependencyAnalysis:analysis},[],'asset')).toMatchObject({generationAllowed:true,technicalValidationAllowed:false});
});

it('counts an unsupported dependency reference once instead of rejecting its container twice',()=>{
 const payload={dependencyAnalysis:{dependencies:[{key:'unknown',name:'unknown',kind:'SDK',owner:'TOOL',action:'KEEP',
  contractStatus:'KNOWN',sensitive:false,purpose:'未知工具依赖',blocking:false,availability:'AVAILABLE',
  references:[{toolName:'missing_tool',path:'SKILL.md',snippet:source.split('\n')[0]!}],resolvedPaths:[]}],chains:[]}};
 const inspection=toProjectInspection({tools:[],runtimeCapabilities:[]},'asset','digest',stableToolId,null,files);
 expect(analyzeDependencies(payload,inspection,files,[],0,'digest')).toMatchObject({status:'PARTIAL',dependencies:[],rejectedClaims:1});
});

it('does not exclude same-named business tools based on name alone or invalid evidence',()=>{
 for(const capabilities of [[],[{...harness,evidence:[{path:'SKILL.md',snippet:'not actual source evidence'}]}]]){
  const inspection=toProjectInspection({tools:[tool],runtimeCapabilities:capabilities},'asset','digest',stableToolId,null,files);
  expect(inspection.tools.map(t=>t.name)).toEqual(['read_file']);
  expect(inspection.runtimeCapabilities).toEqual([]);
 }
});

it('keeps the business consumer in migration and normalizes harness evidence paths',()=>{
 const inspection=toProjectInspection({tools:[tool,{name:'lookup',sourcePaths:['SKILL.md']}],
  runtimeCapabilities:[{...harness,evidence:[{path:'C:/temp/package/SKILL.md',snippet:harness.evidence[0]!.snippet}]}]},
 'asset','digest',stableToolId,null,files);
 expect(inspection.tools.map(t=>t.name)).toEqual(['lookup']);
 expect(inspection.runtimeCapabilities?.[0]?.evidence[0]?.path).toBe('SKILL.md');
});

it('does not turn source framework registration and response wrappers into Harness plugins',()=>{
 const runtime=`from agentscope.tool import ToolBase, ToolResponse, Toolkit\nclass BalanceTool(ToolBase): pass\ndef build_toolkit(context): return Toolkit(tools=[BalanceTool(context)])\n`;
 const business='def get_balance(account_id, context): return {"account_id": account_id}\n';
 const capability={
  name:'AgentScope 工具注册与结果构造（ToolBase/Toolkit/ToolResponse）',
  reason:'源 Runtime 框架注册与结果构造能力，只存在于适配层',
  usageContract:'Toolkit 注册业务工具，ToolResponse 包装返回结果',
  consumerTools:['get_balance'],
  evidence:[
   {path:'runtime.py',snippet:'from agentscope.tool import ToolBase, ToolResponse, Toolkit'},
   {path:'runtime.py',snippet:'def build_toolkit(context): return Toolkit(tools=[BalanceTool(context)])'},
  ],
 };
 const inspection=toProjectInspection({tools:[{name:'get_balance',sourcePaths:['runtime.py','tools/balance.py'],portability:'RUNTIME_BOUND'}],runtimeCapabilities:[capability]},
  'asset','digest',stableToolId,null,{'runtime.py':runtime,'tools/balance.py':business});
 expect(inspection.tools.map(tool=>tool.name)).toEqual(['get_balance']);
 expect(inspection.runtimeCapabilities).toEqual([]);
});
