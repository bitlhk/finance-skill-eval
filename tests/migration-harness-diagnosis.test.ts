import {expect,it} from 'vitest';
import {toProjectInspection} from '../src/service/migration-agent.js';
import {buildMigrationPlan,stableToolId} from '../src/service/migration-model.js';
import {analyzeDependencies} from '../src/service/migration-dependencies.js';

const source='Runtime harness provides read_file(path) for workspace files.\nBusiness lookup uses read_file to read a local report.\n';
const files={'SKILL.md':source};
const harness={name:'read_file',reason:'Runtime 通用文件读取，不建议与 Skill 绑定',usageContract:'path 相对工作区；返回文本；权限及错误待确认',
 consumerTools:['lookup'],evidence:[{path:'SKILL.md',snippet:source.split('\n')[0]!}]};
const tool={name:'read_file',sourcePaths:['SKILL.md'],portability:'RUNTIME_BOUND'};

it('retains verified harness requirements without generating or blocking their migration',()=>{
 const payload={tools:[tool],runtimeCapabilities:[harness],dependencyAnalysis:{dependencies:[],chains:[]}};
 const inspection=toProjectInspection(payload,'asset','digest',stableToolId,null,files);
 inspection.dependencyAnalysis=analyzeDependencies(payload,inspection,files,[],0,'digest');
 expect(inspection.tools).toEqual([]);
 expect(inspection.runtimeCapabilities?.[0]).toMatchObject({owner:'RUNTIME_HARNESS',migrationAction:'DO_NOT_MIGRATE',blocking:false,
  testAvailability:'UNCHECKED',targetCapability:null,consumerTools:['lookup'],evidence:[{path:'SKILL.md',line:1}]});
 expect(inspection.dependencyAnalysis.status).toBe('COMPLETE');
 expect(buildMigrationPlan(inspection,[],'asset').generationAllowed).toBe(true);
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
