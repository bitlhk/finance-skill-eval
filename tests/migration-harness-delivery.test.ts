import {expect,it} from 'vitest';
import {strToU8} from 'fflate';
import {harnessDeliveryContract,toGeneratedHarnessPlugins} from '../src/service/migration-harness.js';
import {generatePortableCandidate} from '../src/service/portable-candidate.js';
import {inspectionFixture,SKILL_MD} from './analysis-fixture.js';

function fixture(){
  const inspection=inspectionFixture([]);
  inspection.runtimeCapabilities=[{name:'read_document',owner:'RUNTIME_HARNESS',migrationAction:'DO_NOT_MIGRATE',blocking:false,
    reason:'原 Runtime 文件能力',usageContract:'path:string -> string; 保留错误语义',targetCapability:'read_file',testAvailability:'UNCHECKED',consumerTools:[],
    evidence:[{path:'tools/original.py',line:1,kind:'SOURCE',detail:'def read_document(path: str) -> str:'}]}];
  const contents={
    'runtime-plugins/document/manifest.json':JSON.stringify({packageType:'plugin',id:'document',tools:[{file:'adapter/tool.py',class:'DocumentTool'}]}),
    'runtime-plugins/document/implementation/original.py':'def read_document(path: str) -> str:\n    return open(path).read()\n',
    'runtime-plugins/document/adapter/tool.py':'from ..implementation.original import read_document\n',
  };
  const plugin={status:'PRODUCED',toolNames:['read_document'],manifestPath:'runtime-plugins/document/manifest.json',files:Object.keys(contents),
    implementationFiles:['runtime-plugins/document/implementation/original.py'],adapterFiles:['runtime-plugins/document/adapter/tool.py'],compilePassed:true,contractPassed:true,callExecuted:false};
  const encoded=Object.fromEntries(Object.entries(contents).map(([path,content])=>[path,Buffer.from(content).toString('base64')]));
  return {inspection,plugin,encoded};
}

it('requires preservation even when diagnosis mentions a similar target builtin',()=>{
  const {inspection,plugin,encoded}=fixture();
  expect(harnessDeliveryContract(inspection).builtinMapping).toBe(false);
  expect(toGeneratedHarnessPlugins({harnessPlugins:[plugin]},encoded,inspection)[0]?.toolNames).toEqual(['read_document']);
  expect(()=>toGeneratedHarnessPlugins({harnessPlugins:[{...plugin,toolNames:['read_file']}]},encoded,inspection)).toThrow('不允许改名');
  expect(()=>toGeneratedHarnessPlugins({},encoded,inspection)).toThrow('不允许改名');
});

it('requires distinct original implementation and Runtime adapter files',()=>{
  const {inspection,plugin,encoded}=fixture();
  expect(()=>toGeneratedHarnessPlugins({harnessPlugins:[{...plugin,implementationFiles:plugin.adapterFiles}]},encoded,inspection)).toThrow('未分开');
  expect(()=>toGeneratedHarnessPlugins({harnessPlugins:[{...plugin,files:plugin.files.filter(path=>!path.endsWith('original.py'))}]},encoded,inspection)).toThrow('不完整');
  expect(()=>toGeneratedHarnessPlugins({harnessPlugins:[{...plugin,manifestPath:'../manifest.json'}]},encoded,inspection)).toThrow();
});

it('packages Harness separately while keeping Skill tool names and pending behavior evidence',()=>{
  const {inspection,plugin,encoded}=fixture();
  const harnessPlugins=toGeneratedHarnessPlugins({harnessPlugins:[plugin]},encoded,inspection);
  const archive={'SKILL.md':strToU8(SKILL_MD+'\nCall read_document with the path.\n'),'tools/original.py':strToU8('old Runtime implementation')};
  const candidate=generatePortableCandidate({archive,base:{skillFile:'SKILL.md',skillId:'test'} as any,inspection,decisions:[],version:'2.0.0',harnessPlugins});
  expect(candidate.files[plugin.manifestPath]).toBeDefined();
  expect(candidate.files[plugin.implementationFiles[0]!]).toBeDefined();
  expect(candidate.generations).toEqual([]);
  const instructions=Buffer.from(candidate.files['SKILL.md']!).toString();
  expect(instructions).toContain('Call read_document');
  expect(instructions).not.toContain('read_file');
  expect(Object.keys(candidate.files).some(path=>path.startsWith('scripts/runtime-plugins'))).toBe(false);
  expect(JSON.parse(Buffer.from(candidate.files['runtime-plugins/plugins.json']!).toString()).plugins[0].callExecuted).toBe(false);
});
