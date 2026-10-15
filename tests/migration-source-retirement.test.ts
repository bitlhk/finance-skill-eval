import {it,expect} from 'vitest';
import {strToU8} from 'fflate';
import {parseRetiredSources,sourceRetirementIssues} from '../src/migration/domain/migration-source-retirement.js';
import {agentDocumentDeliveryIssues} from '../src/migration/domain/migration-delivery-contract.js';
import {toSkillDocumentDelivery} from '../src/migration/infrastructure/migration-agent-result-mapper.js';
import {generatePortableCandidate} from '../src/migration/infrastructure/migration-candidate-packager.js';
import {inspectionFixture,toolFixture,SKILL_MD} from './analysis-fixture.js';

const retired={path:'tools/register.py',reason:'Original registration imports the replaced business module; the new MCP service registers the approved tools.'};
const document={skillFile:'SKILL.md',files:[{source:'migration-skill/SKILL.md',path:'SKILL.md'}]};
const encoded={'migration-skill/SKILL.md':Buffer.from(SKILL_MD).toString('base64')};

it('keeps historical deliveries optional and preserves explicit decisions without collecting or deleting originals',()=>{
 expect(parseRetiredSources(undefined)).toEqual([]);
 expect(toSkillDocumentDelivery({skillDelivery:document},encoded)).toEqual({files:{'SKILL.md':SKILL_MD}});
 expect(toSkillDocumentDelivery({skillDelivery:{...document,retiredSources:[retired]}},encoded)).toEqual({files:{'SKILL.md':SKILL_MD},retiredSources:[retired]});
 expect(agentDocumentDeliveryIssues({skillDelivery:{...document,retiredSources:[retired]}},encoded)).toEqual([]);
});

it.each([null,'register.py',{},[null],[{path:'../register.py',reason:'x'}],[{path:'/register.py',reason:'x'}],
 [{path:'C:/register.py',reason:'x'}],[{path:'tools//register.py',reason:'x'}],[{path:'tools/./register.py',reason:'x'}],
 [{path:'tools/register.py',reason:' '}],[{...retired,override:true}],[retired,{...retired,path:'TOOLS/REGISTER.PY'}],
 [{path:'tools/evil\0.py',reason:'x'}],Array.from({length:101},(_,i)=>({path:`tools/${i}.py`,reason:'x'}))])('rejects malformed, unsafe or ambiguous retirement manifests: %j',value=>{
 expect(parseRetiredSources(value)).toBeNull();
 expect(toSkillDocumentDelivery({skillDelivery:{...document,retiredSources:value}},encoded)).toBeNull();
 expect(agentDocumentDeliveryIssues({skillDelivery:{...document,retiredSources:value}},encoded).join()).toContain('retiredSources');
});

function candidate(){
 const tool=toolFixture({name:'query_receivables',sourcePaths:['tools/ledger.py'],language:'Python'}),inspection=inspectionFixture([tool]);
 const archive=Object.fromEntries(Object.entries({'SKILL.md':SKILL_MD,'tools/ledger.py':'old business code','tools/register.py':'from .ledger import query_receivables','tools/__init__.py':'','assets/rules.json':'{}'}).map(([path,source])=>[path,strToU8(source)]));
 return {archive,base:{skillFile:'SKILL.md',skillId:'test'} as any,inspection,decisions:[{toolId:tool.toolId,form:'MCP',language:'python'}] as any,version:'2.0.0',
  skillDelivery:{files:{'SKILL.md':SKILL_MD},retiredSources:[retired]},
  implementations:{[tool.toolId]:{language:'python',sourcePath:'mcp-python/server.py',source:'new server',additionalFiles:[],dependencies:[],start:['python','mcp-python/server.py']}} as any};
}

it('retires only explicitly declared glue, exposes the deletion reason and leaves original bytes intact',()=>{
 const input=candidate(),original=Object.fromEntries(Object.entries(input.archive).map(([path,bytes])=>[path,Buffer.from(bytes).toString('base64')]));
 const result=generatePortableCandidate(input);
 expect(Object.keys(result.files).some(path=>path.endsWith('register.py'))).toBe(false);
 expect(Object.keys(result.files).some(path=>path.endsWith('__init__.py'))).toBe(false);
 expect(result.files['skill/assets/rules.json']).toBeDefined();
 expect(result.diff).toContainEqual({path:retired.path,operation:'DELETE',before:'from .ledger import query_receivables',after:'',reason:retired.reason});
 expect(Object.fromEntries(Object.entries(input.archive).map(([path,bytes])=>[path,Buffer.from(bytes).toString('base64')]))).toEqual(original);
 input.skillDelivery.retiredSources=[];
 expect(Object.keys(generatePortableCandidate(input).files).some(path=>path.endsWith('register.py'))).toBe(true);
});

it.each(['missing.py','SKILL.md','assets/rules.json','references/rules.py','workspace/input.py'])('rejects nonexistent, document, resource and runtime-data removals: %s',path=>{
 const input=candidate();input.archive[path]??=strToU8('source');if(path==='missing.py')delete input.archive[path];
 input.skillDelivery.retiredSources=[{path,reason:'replaced'}];
 expect(()=>generatePortableCandidate(input)).toThrow(/退役/);
});

it.each(['tool','dependency'])('refuses retiring shared code still consumed by an unmigrated %s',kind=>{
 const input=candidate(),other=toolFixture({name:'unmigrated',sourcePaths:kind==='tool'?[retired.path]:['other.py']});input.inspection.tools.push(other);
 if(kind==='dependency')input.inspection.dependencyAnalysis={dependencies:[{toolIds:[other.toolId],resolvedPaths:[retired.path]}]} as any;
 expect(sourceRetirementIssues([retired],input.archive,input.inspection,input.decisions,'SKILL.md').join()).toContain('未迁移工具');
 expect(()=>generatePortableCandidate(input)).toThrow('未迁移工具');
});

it('rejects a contradictory delivery that retires and re-delivers the same original path',()=>{
 const input=candidate(),tool=input.inspection.tools[0]!;
 input.implementations[tool.toolId].additionalFiles=[{path:retired.path,content:'still delivered'}];
 expect(()=>generatePortableCandidate(input)).toThrow('同时又被交付');
});
