import { strToU8 } from 'fflate';
import type { SkillAssetRecord } from './skill-store.js';
import type { ProjectInspection,ToolDecision } from './migration-model.js';
import { versionedMethod } from './migration-candidate.js';

export type PortableGeneration={toolId:string;toolName:string;action:ToolDecision['action'];files:string[];readyForValidation:boolean;todo:string[]};
export type PortableDiff={path:string;operation:'ADD'|'MODIFY';before:string;after:string};

const javaClass=(name:string)=>name.split(/[^a-zA-Z0-9]+/u).filter(Boolean).map(p=>p[0]!.toUpperCase()+p.slice(1)).join('')+'Tool';
const pythonName=(name:string)=>name.toLowerCase().replace(/[^a-z0-9_]+/gu,'_').replace(/^_+|_+$/gu,'')||'tool';

export function generatePortableCandidate(input:{archive:Record<string,Uint8Array>;base:SkillAssetRecord;inspection:ProjectInspection;decisions:ToolDecision[];version:string}){
  const files={...input.archive},generations:PortableGeneration[]=[];
  if(Object.keys(files).some(name=>name.startsWith('migration-generated/v2/')))throw Object.assign(new Error('候选中已有 2.0 生成文件，请从当前源资产重新检查后生成'),{statusCode:409});
  files[input.base.skillFile]=strToU8(versionedMethod(Buffer.from(files[input.base.skillFile]!).toString('utf8'),input.base.skillId,input.version));
  const mcpDecisions=input.decisions.filter(decision=>decision.action==='MIGRATE_TO_MCP');
  const mcpRoot='migration-generated/v2/mcp-service',packagePath='com/finance/migration';
  const sharedMcpFiles:string[]=[];
  if(mcpDecisions.length){
    const names=mcpDecisions.map(decision=>input.inspection.tools.find(tool=>tool.toolId===decision.toolId)?.name).filter((name):name is string=>!!name);
    const generated=[
      {name:`${mcpRoot}/pom.xml`,content:`<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>com.finance.migration</groupId><artifactId>${input.base.skillId}-mcp-service</artifactId><version>0.1.0</version><properties><maven.compiler.release>17</maven.compiler.release></properties></project>\n`},
      {name:`${mcpRoot}/src/main/java/${packagePath}/MigrationMcpServer.java`,content:`package com.finance.migration;\n\nimport java.util.List;\n\n/** One MCP service for all tools migrated from this Skill. */\npublic final class MigrationMcpServer {\n  public static final List<String> TOOL_NAMES = List.of(${names.map(name=>`"${name}"`).join(', ')});\n  private MigrationMcpServer() {}\n  // TODO: start one MCP transport and register every Tool implementation above.\n}\n`},
      {name:`${mcpRoot}/README.md`,content:`# ${input.base.skillId} MCP service\n\nThis is the single MCP service for this Skill. It must expose all selected tools from one endpoint: ${names.join(', ')}. Connect the reviewed business implementations, declare authoritative schemas, and add initialize/list/call tests before validation.\n`},
    ];
    for(const item of generated){files[item.name]=strToU8(item.content);sharedMcpFiles.push(item.name);}
  }
  for(const decision of input.decisions){
    const tool=input.inspection.tools.find(t=>t.toolId===decision.toolId);if(!tool)throw new Error(`Unknown Tool decision: ${decision.toolId}`);
    if(decision.action==='MIGRATE_TO_MCP'){
      const className=javaClass(tool.name),generated=[{name:`${mcpRoot}/src/main/java/${packagePath}/tools/${className}.java`,content:`package com.finance.migration.tools;\n\n/** Tool implementation registered by the Skill's shared MCP service. */\npublic final class ${className} {\n  public static final String TOOL_NAME = "${tool.name}";\n  private ${className}() {}\n  // TODO: connect the reviewed business implementation and authoritative schemas.\n}\n`}];
      for(const item of generated)files[item.name]=strToU8(item.content);
      generations.push({toolId:tool.toolId,toolName:tool.name,action:decision.action,files:[...sharedMcpFiles,...generated.map(f=>f.name)],readyForValidation:false,todo:['接入原有业务实现','确认输入和输出格式','在共享 MCP 服务中注册并测试']});
    }else{
      const root=`migration-generated/v2/${tool.toolId}`;
      const module=pythonName(tool.name),generated:{name:string;content:string}[]=[
        {name:`${root}/pyproject.toml`,content:`[project]\nname = "${tool.toolId}"\nversion = "0.1.0"\nrequires-python = ">=3.11"\ndependencies = []\n\n[project.scripts]\n${module} = "${module}:main"\n`},
        {name:`${root}/uv.lock`,content:'version = 1\nrevision = 3\nrequires-python = ">=3.11"\n'},
        {name:`${root}/src/${module}.py`,content:`"""Runtime-independent Script Tool candidate for ${tool.name}."""\nimport json\nimport sys\n\ndef main() -> None:\n    request = json.load(sys.stdin)\n    # TODO: call the reviewed existing business implementation.\n    json.dump({"status": "FAILED", "error": "BUSINESS_IMPLEMENTATION_NOT_CONNECTED", "request_received": isinstance(request, dict)}, sys.stdout)\n    raise SystemExit(2)\n\nif __name__ == "__main__":\n    main()\n`},
        {name:`${root}/README.md`,content:`# ${tool.name}\n\nPython Script Tool migration candidate. Connect the existing business implementation and replace the explicit failure with the reviewed result before validation. Environment preparation belongs to this Tool project, not SKILL.md.\n`},
      ];
      for(const item of generated)files[item.name]=strToU8(item.content);
      generations.push({toolId:tool.toolId,toolName:tool.name,action:decision.action,files:generated.map(f=>f.name),readyForValidation:false,todo:['接入原有业务实现','确认输入和输出格式','补充正常与错误测试']});
    }
  }
  const diff:PortableDiff[]=Object.entries(files).flatMap(([name,bytes])=>{
    const before=input.archive[name];
    if(before&&Buffer.compare(Buffer.from(before),Buffer.from(bytes))===0)return [];
    return [{path:name,operation:before?'MODIFY':'ADD',before:before?Buffer.from(before).toString('utf8'):'',after:Buffer.from(bytes).toString('utf8')} as PortableDiff];
  });
  return {files,generations,diff};
}
