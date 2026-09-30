import { expect, it } from 'vitest';
import { strToU8 } from 'fflate';
import { generatePortableCandidate } from '../src/migration/infrastructure/migration-candidate-packager.js';
import type { GeneratedToolImplementation } from '../src/migration/domain/generated-tool-implementation.js';
import { inspectionFixture, toolFixture } from './analysis-fixture.js';

/**
 * The candidate package is assembled, not generated.
 *
 * Everything that runs is written by the A4 agent -- the MCP service, its adapters, the Script
 * program -- and the agent starts and contract-tests it inside its own loop. What the platform
 * owes is the Skill layout, path safety and the diff. So these tests are about *placing* what
 * came back, and about refusing what cannot be placed; there are no templates left to assert.
 */
const base={schemaVersion:'finance.skill-eval.skill-asset.v1' as const,assetId:'asset',skillId:'multi-lang',version:'1.0.0',
  displayName:'multi',description:'test',sourceType:'uploaded' as const,artifactSha256:'d'.repeat(64),skillFile:'skill/SKILL.md',fileCount:3,createdAt:'now'};
const script=(name:string)=>`import json\nimport sys\n\n\ndef main():\n    json.dump({"tool": "${name}"}, sys.stdout)\n\n\nif __name__ == "__main__":\n    main()\n`;
const implementation=(language:GeneratedToolImplementation['language'],sourcePath:string,name:string,extra?:Partial<GeneratedToolImplementation>):GeneratedToolImplementation=>
  ({language,sourcePath,source:script(name),additionalFiles:[],dependencies:[],smokeInput:{},generatedBy:`test/${language}`,explanation:'generated',attempts:1,checks:[],...extra});

const ARCHIVE=()=>
  ({'skill/SKILL.md':strToU8('---\nname: multi-lang\ndescription: 验证多语言迁移。\n---\n调用 `lookup`。'),
    'tool/scripts/lookup.py':strToU8('import json,sys\ndef lookup(value): return value\nif __name__ == "__main__": json.dump(lookup(json.load(sys.stdin)),sys.stdout)')});

/** The two Tools a test may need, in whatever language the case is about. */
const skillWith=(tools:Array<{name:string;language:string}>)=>
  inspectionFixture(tools.map(tool=>toolFixture({name:tool.name,sourcePaths:[`tool/${tool.name}.py`],language:tool.language})));

it('places an MCP service at the paths the agent reported, instead of generating one',()=>{
  const inspection=skillWith([{name:'lookup',language:'Python'}]);
  const tool=inspection.tools[0]!;
  const generated=generatePortableCandidate({archive:ARCHIVE(),base,inspection,version:'2.0.0',
    decisions:[{toolId:tool.toolId,form:'MCP',language:'python',reason:'shared',baseAssetId:'asset',decidedAt:'now'}],
    implementations:{[tool.toolId]:implementation('python','mcp-python/server.py','lookup',{
      additionalFiles:[{path:'mcp-python/tools/lookup.py',content:'# adapter\n'},{path:'mcp-python/pyproject.toml',content:'[project]\nname="x"\n'}],
      start:['uv','run','--no-project','mcp-python/server.py'],
    })}});
  const names=Object.keys(generated.files);
  expect(names).toContain('mcp-python/server.py');
  expect(names).toContain('mcp-python/tools/lookup.py');
  expect(names).toContain('mcp-python/pyproject.toml');
  // The platform used to write the service from a template. It must not any more.
  expect(names.some(name=>name.endsWith('Dockerfile'))).toBe(false);
  expect(generated.generations[0]).toMatchObject({
    entrypoint:'mcp-python/server.py',
    start:['uv','run','--no-project','mcp-python/server.py'],
    readyForValidation:true,
  });
});

it('keeps the preparation step the agent declared',()=>{
  const inspection=skillWith([{name:'lookup',language:'JavaScript'}]);
  const tool=inspection.tools[0]!;
  const generated=generatePortableCandidate({archive:ARCHIVE(),base,inspection,version:'2.0.0',
    decisions:[{toolId:tool.toolId,form:'MCP',language:'node',reason:'shared',baseAssetId:'asset',decidedAt:'now'}],
    implementations:{[tool.toolId]:implementation('node','mcp-node/server.js','lookup',{
      prepare:['npm','install','--omit=dev'],start:['node','mcp-node/server.js']})}});
  expect(generated.generations[0]).toMatchObject({prepare:['npm','install','--omit=dev'],start:['node','mcp-node/server.js']});
});

it('carries the interface-change report without letting it gate the package',()=>{
  const inspection=skillWith([{name:'lookup',language:'Python'}]);
  const tool=inspection.tools[0]!;
  const generated=generatePortableCandidate({archive:ARCHIVE(),base,inspection,version:'2.0.0',
    decisions:[{toolId:tool.toolId,form:'MCP',language:'python',reason:'shared',baseAssetId:'asset',decidedAt:'now'}],
    implementations:{[tool.toolId]:implementation('python','mcp-python/server.py','lookup',{
      changes:[{path:'account_id',change:'改名为 accountId',reason:'MCP 参数用驼峰'}],
      drift:[{where:'inputSchema',baseline:{required:['account_id']},observed:{required:['accountId']}}]})}});
  expect(generated.generations[0]).toMatchObject({
    readyForValidation:true,
    changes:[{path:'account_id',change:'改名为 accountId',reason:'MCP 参数用驼峰'}],
    drift:[{where:'inputSchema',baseline:{required:['account_id']},observed:{required:['accountId']}}],
  });
});

it('refuses a path that would escape the package',()=>{
  const inspection=skillWith([{name:'lookup',language:'Python'}]);
  const tool=inspection.tools[0]!;
  const attempt=(sourcePath:string)=>generatePortableCandidate({archive:ARCHIVE(),base,inspection,version:'2.0.0',
    decisions:[{toolId:tool.toolId,form:'MCP',language:'python',reason:'shared',baseAssetId:'asset',decidedAt:'now'}],
    implementations:{[tool.toolId]:implementation('python',sourcePath,'lookup')}});
  expect(()=>attempt('../outside.py')).toThrow(/路径不合法/u);
  expect(()=>attempt('/etc/passwd')).toThrow(/路径不合法/u);
});

it('refuses two Tools that claim the same file rather than letting one win',()=>{
  const inspection=skillWith([{name:'lookup',language:'Python'},{name:'tally',language:'Python'}]);
  const [first,second]=inspection.tools;
  const build=()=>generatePortableCandidate({archive:ARCHIVE(),base,inspection,version:'2.0.0',
    decisions:[{toolId:first!.toolId,form:'MCP',language:'python',reason:'shared',baseAssetId:'asset',decidedAt:'now'},
      {toolId:second!.toolId,form:'MCP',language:'python',reason:'shared',baseAssetId:'asset',decidedAt:'now'}],
    implementations:{[first!.toolId]:implementation('python','mcp-python/server.py','lookup'),
      [second!.toolId]:implementation('python','mcp-python/server.py','tally')}});
  expect(build).toThrow(/不同内容/u);
});

it('refuses an implementation in a language the human did not authorize',()=>{
  const inspection=skillWith([{name:'lookup',language:'Python'}]);
  const tool=inspection.tools[0]!;
  expect(()=>generatePortableCandidate({archive:ARCHIVE(),base,inspection,version:'2.0.0',
    decisions:[{toolId:tool.toolId,form:'MCP',language:'python',reason:'shared',baseAssetId:'asset',decidedAt:'now'}],
    implementations:{[tool.toolId]:implementation('java','mcp-java/Server.java','lookup')}}))
    .toThrow(/python/u);
});

it('ships a Node script as ESM because the platform runs it as `node <path>`',()=>{
  const inspection=skillWith([{name:'tally',language:'JavaScript'}]);
  const tool=inspection.tools[0]!;
  const one=generatePortableCandidate({archive:ARCHIVE(),base,inspection,version:'2.0.0',
    decisions:[{toolId:tool.toolId,form:'SCRIPT',language:'node',reason:'local',baseAssetId:'asset',decidedAt:'now'}],
    implementations:{[tool.toolId]:implementation('node','tally.js','tally')}});
  expect(one.files['scripts/tally.mjs']).toBeDefined();
  expect(one.generations[0]!.entrypoint).toBe('scripts/tally.mjs');
  // A multi-file Node script gets its ESM marker from a package.json, not from the extension.
  const many=generatePortableCandidate({archive:ARCHIVE(),base,inspection,version:'2.0.0',
    decisions:[{toolId:tool.toolId,form:'SCRIPT',language:'node',reason:'local',baseAssetId:'asset',decidedAt:'now'}],
    implementations:{[tool.toolId]:{...implementation('node','tally.js','tally'),additionalFiles:[{path:'helper.js',content:'export const helper = 1;\n'}]}}});
  expect(JSON.parse(Buffer.from(many.files['scripts/tally/package.json']!).toString())).toEqual({type:'module'});
  expect(many.files['scripts/tally/helper.js']).toBeDefined();
});
