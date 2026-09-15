import { expect, it } from 'vitest';
import { strToU8 } from 'fflate';
import { inspectProject } from '../src/service/tool-inspector.js';
import { generatePortableCandidate } from '../src/service/portable-candidate.js';
import type { GeneratedToolImplementation } from '../src/service/migration-code-generator.js';

const base={schemaVersion:'finance.skill-eval.skill-asset.v1' as const,assetId:'asset',skillId:'multi-lang',version:'1.0.0',
  displayName:'multi',description:'test',sourceType:'uploaded' as const,artifactSha256:'d'.repeat(64),skillFile:'skill/SKILL.md',fileCount:3,createdAt:'now'};
const pythonBusiness=(name:string)=>`import json\nimport sys\n\n\ndef execute(arguments):\n    return {"tool": "${name}", "value": arguments.get("value")}\n\n\nif __name__ == "__main__":\n    json.dump(execute(json.load(sys.stdin)), sys.stdout)\n`;
const implementation=(language:GeneratedToolImplementation['language'],sourcePath:string,name:string):GeneratedToolImplementation=>
  ({language,sourcePath,source:pythonBusiness(name),additionalFiles:[],dependencies:[],smokeInput:{value:'x'},generatedBy:`test/${language}`,explanation:'generated',attempts:1,checks:[]});

/** A Skill whose two Tools are written in different languages; both go to MCP. */
function twoLanguageSkill(){
  const skill='---\nname: multi-lang\ndescription: 验证多语言 MCP 生成。\n---\n调用 `lookup` 和 `tally`。';
  const archive={'skill/SKILL.md':strToU8(skill),
    'tool/scripts/lookup.py':strToU8('import json,sys\ndef lookup(value): return value\nif __name__ == "__main__": json.dump(lookup(json.load(sys.stdin)),sys.stdout)'),
    'tool/scripts/tally.js':strToU8('import json from "./x.js";\nexport function tally(value){ return value; }\n')};
  const inspection=inspectProject({assetId:'asset',assetDigest:'d'.repeat(64),skillFile:'skill/SKILL.md',
    files:Object.fromEntries(Object.entries(archive).map(([name,bytes])=>[name,Buffer.from(bytes).toString()]))});
  inspection.tools=inspection.tools.map(tool=>({...tool,inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']}}));
  const byName=Object.fromEntries(inspection.tools.map(tool=>[tool.name,tool]));
  return {archive,inspection,byName};
}

it('gives each language its own MCP service instead of forcing one',()=>{
  const {archive,inspection,byName}=twoLanguageSkill();
  const generated=generatePortableCandidate({archive,base,inspection,version:'2.0.0',
    decisions:[{toolId:byName.lookup!.toolId,form:'MCP',reason:'shared',baseAssetId:'asset',decidedAt:'now'},
      {toolId:byName.tally!.toolId,form:'MCP',reason:'shared',baseAssetId:'asset',decidedAt:'now'}],
    implementations:{[byName.lookup!.toolId]:implementation('python','mcp-python/business/lookup.py','lookup'),
      [byName.tally!.toolId]:implementation('node','mcp-node/business/tally.js','tally')}});
  const names=Object.keys(generated.files);
  expect(names).toContain('mcp-python/server.py');
  expect(names).toContain('mcp-python/pyproject.toml');
  expect(names).toContain('mcp-node/server.js');
  expect(names).toContain('mcp-node/package.json');
  // Neither service may carry the other language's business file.
  expect(names.some(name=>name.startsWith('mcp-python/')&&name.endsWith('.js'))).toBe(false);
  expect(names.some(name=>name.startsWith('mcp-node/')&&name.endsWith('.py'))).toBe(false);
});

it('advertises the source Tool Schema verbatim rather than one derived from a signature',()=>{
  const {archive,inspection,byName}=twoLanguageSkill();
  const generated=generatePortableCandidate({archive,base,inspection,version:'2.0.0',
    decisions:[{toolId:byName.lookup!.toolId,form:'MCP',reason:'shared',baseAssetId:'asset',decidedAt:'now'}],
    implementations:{[byName.lookup!.toolId]:implementation('python','mcp-python/business/lookup.py','lookup')}});
  const schema=JSON.stringify(byName.lookup!.inputSchema);
  const adapter=Buffer.from(generated.files['mcp-python/tools/lookup.py']!).toString();
  expect(adapter).toContain(`INPUT_SCHEMA = json.loads(${JSON.stringify(schema)})`);
  // The server hands that Schema straight to tools/list; it never derives one from a signature.
  expect(Buffer.from(generated.files['mcp-python/server.py']!).toString()).toContain('inputSchema=schema');
});

it('only generates imports that resolve to files it also generated',()=>{
  const {archive,inspection,byName}=twoLanguageSkill();
  const generated=generatePortableCandidate({archive,base,inspection,version:'2.0.0',
    decisions:[{toolId:byName.lookup!.toolId,form:'MCP',reason:'shared',baseAssetId:'asset',decidedAt:'now'},
      {toolId:byName.tally!.toolId,form:'MCP',reason:'shared',baseAssetId:'asset',decidedAt:'now'}],
    implementations:{[byName.lookup!.toolId]:implementation('python','mcp-python/business/lookup.py','lookup'),
      [byName.tally!.toolId]:implementation('node','mcp-node/business/tally.js','tally')}});
  const names=new Set(Object.keys(generated.files));
  const pythonServer=Buffer.from(generated.files['mcp-python/server.py']!).toString();
  for(const match of pythonServer.matchAll(/from (tools\.[a-z_0-9]+) import/gu))
    expect(names).toContain(`mcp-python/${match[1]!.replace('.','/')}.py`);
  const nodeServer=Buffer.from(generated.files['mcp-node/server.js']!).toString();
  for(const match of nodeServer.matchAll(/from "\.\/(tools\/[^"]+)"/gu))
    expect(names).toContain(`mcp-node/${match[1]}`);
  // The adapters must reach the business implementation that shipped beside them.
  expect(Buffer.from(generated.files['mcp-python/tools/lookup.py']!).toString()).toContain('from business.lookup import execute');
  expect(generated.files['mcp-python/business/lookup.py']).toBeDefined();
  expect(Buffer.from(generated.files['mcp-node/tools/tally.js']!).toString()).toContain('from "../business/tally.js"');
});

it('keeps a Tool name that is not a valid identifier out of the generated identifiers',()=>{
  const skill='---\nname: odd-name\ndescription: 名称规范化验证。\n---\n调用 `tally_tool`。';
  const archive={'skill/SKILL.md':strToU8(skill),'tool/scripts/x.js':strToU8('export function tally_tool(){ return 1; }\n')};
  const inspection=inspectProject({assetId:'asset',assetDigest:'d'.repeat(64),skillFile:'skill/SKILL.md',
    files:{'skill/SKILL.md':skill,'tool/scripts/x.js':'// tally_tool\nexport function tally_tool(){ return 1; }\n'}});
  expect(inspection.tools).toHaveLength(1);
  inspection.tools=inspection.tools.map(tool=>({...tool,name:'2fa-check'}));
  const tool=inspection.tools[0]!;
  const generated=generatePortableCandidate({archive,base,inspection,version:'2.0.0',
    decisions:[{toolId:tool.toolId,form:'MCP',reason:'shared',baseAssetId:'asset',decidedAt:'now'}],
    implementations:{[tool.toolId]:implementation('node','mcp-node/business/tool-2fa-check.js','2fa-check')}});
  const server=Buffer.from(generated.files['mcp-node/server.js']!).toString();
  expect(server).not.toMatch(/import \* as 2fa/u);
  expect(server).toMatch(/import \* as tool2faCheck from "\.\/tools\/tool-2fa-check\.js";/u);
});

it('refuses an implementation written in a language the service is not',()=>{
  const {archive,inspection,byName}=twoLanguageSkill();
  expect(()=>generatePortableCandidate({archive,base,inspection,version:'2.0.0',
    decisions:[{toolId:byName.lookup!.toolId,form:'MCP',language:'python',reason:'shared',baseAssetId:'asset',decidedAt:'now'}],
    implementations:{[byName.lookup!.toolId]:implementation('java','LookupBusiness.java','lookup')}}))
    .toThrow(/python/);
});

it('ships a Node script as ESM because the platform runs it as `node <path>`',()=>{
  const skill='---\nname: node-script\ndescription: Node 脚本生成。\n---\n调用 `tally`。';
  const archive={'skill/SKILL.md':strToU8(skill),'tool/scripts/tally.js':strToU8('export function tally(){ return 1; }\n')};
  const inspection=inspectProject({assetId:'asset',assetDigest:'d'.repeat(64),skillFile:'skill/SKILL.md',
    files:{'skill/SKILL.md':skill,'tool/scripts/tally.js':'// tally\nexport function tally(){ return 1; }\n'}});
  const tool=inspection.tools[0]!;
  const generated=generatePortableCandidate({archive,base,inspection,version:'2.0.0',
    decisions:[{toolId:tool.toolId,form:'SCRIPT',language:'node',reason:'local',baseAssetId:'asset',decidedAt:'now'}],
    implementations:{[tool.toolId]:implementation('node','mcp-node/business/tally.js','tally')}});
  expect(generated.files['scripts/tally.mjs']).toBeDefined();
  expect(generated.generations[0]!.entrypoint).toBe('scripts/tally.mjs');
  // A multi-file Node script gets its ESM marker from a package.json, not from the extension.
  const multi=generatePortableCandidate({archive,base,inspection,version:'2.0.0',
    decisions:[{toolId:tool.toolId,form:'SCRIPT',language:'node',reason:'local',baseAssetId:'asset',decidedAt:'now'}],
    implementations:{[tool.toolId]:{...implementation('node','mcp-node/business/tally.js','tally'),additionalFiles:[{path:'helper.js',content:'export const helper = 1;\n'}]}}});
  expect(JSON.parse(Buffer.from(multi.files['scripts/tally/package.json']!).toString())).toEqual({type:'module'});
  expect(multi.files['scripts/tally/helper.js']).toBeDefined();
});
