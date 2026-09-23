import path from 'node:path';
import { strToU8 } from 'fflate';
import type { Diagnosis } from './migration-diagnostics.js';
import type { SkillAssetRecord } from '../../service/skill-store.js';
import type { NativeTarget } from './migration-target.js';
import { versionedMethod } from '../domain/migration-method-version.js';

const generatedNames=new Set(['neutral-contract.json','neutral_result.py','agentscope_result_adapter.py','OpenJiuwenMigrationTool.java','review.json','README.md']);

/** Rebuild only owned generated files; preserve edited method/resources and refuse unknown overlays. */
export function regenerationArchive(archive:Record<string,Uint8Array>,base:SkillAssetRecord){
  const files={...archive};
  const generated=Object.keys(files).filter(name=>name.startsWith('migration-generated/'));
  if(generated.length){
    const contract=JSON.parse(Buffer.from(files['migration-generated/neutral-contract.json']??[]).toString());
    if(contract.schemaVersion!=='migration.neutral-contract.proposal.v1'||contract.skillId!==base.skillId||contract.method!==base.skillFile)
      throw Object.assign(new Error('生成声明与当前方法不一致，请人工处理冲突'),{statusCode:409});
    if(generated.some(name=>!generatedNames.has(name.slice('migration-generated/'.length))))
      throw Object.assign(new Error('生成目录包含自定义文件，不能自动覆盖；请保留并人工处理冲突'),{statusCode:409});
    for(const name of generated)delete files[name];
  }
  return files;
}

export function generateCandidateFiles(archive:Record<string,Uint8Array>,base:SkillAssetRecord,diagnosis:Diagnosis,
  version:string,target:{runtime:string;environmentId?:string;intent:string},simulation?:{id:string;target:NativeTarget}){
  const original=Buffer.from(archive[base.skillFile]!).toString('utf8');
  const folder='migration-generated';
  if(Object.keys(archive).some(name=>name.startsWith(folder+'/')))throw Object.assign(new Error('已有生成目录；请从原始项目生成新的候选，避免覆盖'),{statusCode:409});
  const files={...archive};
  files[base.skillFile]=strToU8(versionedMethod(original,base.skillId,version));
  const tools=[...new Set([...original.matchAll(/(?:^-\s*|调用\s*)`([a-zA-Z_][a-zA-Z0-9_]*)`/gm)].map(m=>m[1]!))];
  const resources=[...new Set([...original.matchAll(/`((?:references?|scripts)\/[^`]+)`/g)].map(m=>m[1]!))].map(ref=>{
    const requested=path.posix.join(path.posix.dirname(base.skillFile),ref);
    const alternative=Object.keys(archive).filter(name=>path.posix.basename(name)===path.posix.basename(ref));
    return {reference:ref,path:requested in archive?requested:null,
      proposedPath:!(requested in archive)&&alternative.length===1?alternative[0]:null,
      visibility:/\.(yaml|yml|json)$/.test(ref)?'TOOL_ONLY':'METHOD_CONTEXT',
      state:requested in archive?'PRESENT':'OWNER_REVIEW_REQUIRED'};
  });
  const write=(name:string,text:string)=>{files[`${folder}/${name}`]=strToU8(text);};
  write('neutral-contract.json',JSON.stringify({schemaVersion:'migration.neutral-contract.proposal.v1',
    skillId:base.skillId,version,method:base.skillFile,methodState:'BUSINESS_TEXT_PRESERVED_NOT_DECOUPLING_ACCEPTED',
    capabilities:tools.map(name=>({name,operation:'UNCONFIRMED',inputSchema:null,outputSchema:null,
      binding:'HOST_REVIEW_REQUIRED',evidence:diagnosis.declarations.filter(d=>d.name===name)})),resources,
    unboundDeclarations:diagnosis.declarations,
    resultContract:{schemaVersion:'migration.tool-result.v1',fields:['status','text','data','sources'],
      status:['COMPLETED','MISSING','REJECTED','FAILED'],rules:['Never map missing to zero','Preserve units and source values','No implicit suitability decision']},
    target,acceptance:'NOT_VALIDATED'},null,2));
  write('neutral_result.py',`"""Proposed neutral result contract. No runtime imports or source execution."""
from dataclasses import dataclass
from typing import Any

@dataclass(frozen=True)
class NeutralResult:
    status: str
    text: str
    data: Any = None
    sources: tuple = ()

    def __post_init__(self):
        if self.status not in ("COMPLETED", "MISSING", "REJECTED", "FAILED"):
            raise ValueError("UNKNOWN_RESULT_STATUS")
`);
  write('agentscope_result_adapter.py',`"""Review-only SDK boundary. Original uploaded modules are never imported here."""
import json
import inspect
from agentscope.tool import ToolResponse
from agentscope.message import TextBlock

def to_agentscope(result):
    # Preserve the neutral envelope, including missing/rejected states, in text.
    payload = {"status": result.status, "text": result.text,
               "data": result.data, "sources": list(result.sources)}
    return ToolResponse(content=[TextBlock(type="text", text=json.dumps(payload, ensure_ascii=False))])

def register_checked(toolkit, name, description, schema, business_call, check_current_access):
    async def invoke(**arguments):
        check_current_access()
        result = business_call(arguments)
        if inspect.isawaitable(result):
            result = await result
        check_current_access()
        return to_agentscope(result)
    toolkit.register_tool_function(tool_func=invoke, func_name=name,
        func_description=description, json_schema=schema)
`);
  write('OpenJiuwenMigrationTool.java',`import com.openjiuwen.core.foundation.tool.Tool;
import com.openjiuwen.core.foundation.tool.ToolCard;
import com.openjiuwen.core.foundation.tool.function.LocalFunction;
import java.util.Map;
import java.util.Objects;
import java.util.function.Function;

/** Review-only bridge using the repository's OpenJiuwen 0.1.13 Tool API.
 * Host supplies trusted checks, reviewed schemas and a neutral business port.
 * No uploaded source is loaded, executed or granted permission by this adapter.
 */
public final class OpenJiuwenMigrationTool {
    public static Tool create(ToolCard reviewedCard,
            Function<Map<String, Object>, Object> neutralBusinessPort,
            Runnable checkCurrentAccess) {
        Objects.requireNonNull(reviewedCard);
        Objects.requireNonNull(neutralBusinessPort);
        Objects.requireNonNull(checkCurrentAccess);
        return new LocalFunction(reviewedCard, arguments -> {
            checkCurrentAccess.run();
            Object result = neutralBusinessPort.apply(arguments);
            checkCurrentAccess.run();
            return result;
        });
    }
}
`);
  write('review.json',JSON.stringify({sourceDigest:base.artifactSha256,diagnosisDigest:diagnosis.digest,target,
    automatic:['Versioned metadata','Neutral capability/resource proposal','Separate result and registration adapter drafts'],
    requiresEngineering:['Review schemas and business port implementation','Wire resource projection','Compile adapters against actual Runtime','Host authorization and model-boundary checks'],
    unresolved:diagnosis.findings.filter(f=>f.layer==='UNKNOWN'||f.layer==='BUSINESS').map(f=>f.id),
    uploadedScriptsExecuted:false,adapterCompilation:'NOT_RUN',originalBaseline:'NOT_RUN',targetExecution:'NOT_RUN',
    builderImport:'NOT_VERIFIED',businessMethodChanged:false},null,2));
  write('README.md',`# Migration review draft\n\nThe original files remain in their original paths. Only method metadata/version is normalized.\n\nneutral-contract.json is a PROPOSED runtime-neutral declaration, not a Harness Capability Pack.\nThe Python and Java files are real boundary adapter drafts, NOT installed or executed.\nThe business port, schemas, resources and trusted authorization must be supplied and reviewed by the host owner.\nDo not import original uploaded Python modules to fill the business port.\nReview reference/proposedPath differences and business terminology with their owners.\nThe original SOP may still describe legacy registration. This draft does not claim complete decoupling.\nNo script, model, bank service or native runtime was executed during generation.\n`);
  if(simulation){
    const profile=simulation.target.profiles[simulation.id];
    if(!profile||profile.skillId!==base.skillId||profile.tools.length!==tools.length||profile.tools.some(t=>!tools.includes(t.name)))throw new Error('源方法工具与模拟端口不匹配，不能自动补实现');
    const mapped=resources.map(r=>{const actual=r.path??r.proposedPath;if(!actual)throw new Error('资源映射不唯一，需要先补齐源文件');return {...r,path:actual,state:'REVIEWED_SYNTHETIC_SCOPE'};});
    let method=Buffer.from(files[base.skillFile]!).toString('utf8');
    // Only the explicit host injection contract and verified relative paths change.
    method=method.replace('由 Skill 注册层在本 Skill 激活时自动注入提示词','由目标 Host 按中立资源声明加载到方法上下文');
    for(const r of mapped)method=method.split('`'+r.reference+'`').join('`'+path.posix.relative(path.posix.dirname(base.skillFile),r.path)+'`');
    files[base.skillFile]=strToU8(method);
    write('neutral-contract.json',JSON.stringify({schemaVersion:'migration.neutral-contract.proposal.v1',skillId:base.skillId,version,method:base.skillFile,
      executionProfile:simulation.id,sourceKind:'CONTROLLED_SYNTHETIC_BANK',
      capabilities:profile.tools.map(t=>({...t,operation:'QUERY',binding:'HOST_SYNTHETIC_PORT',schemaBasis:profile.schemaBasis,originalOutputSchemaResolved:false,
        sourceEvidence:original.split('\n').map((line,index)=>({path:base.skillFile,line:index+1,text:line})).filter(e=>e.text.includes(t.name))})),
      resources:mapped,mappingReview:{approved:true,scope:'SIMULATED_TARGET_ONLY',portsSha256:simulation.target.portsSha256,sourceDigest:base.artifactSha256},
      unresolved:diagnosis.findings.filter(f=>f.layer==='UNKNOWN'||f.layer==='BUSINESS').map(f=>({path:f.path,line:f.line,reason:f.reason})),
      originalNativeEquivalent:false,target},null,2));
    write('README.md','# Simulated target candidate\n\nThe target Host loads only the neutral declaration, versioned method and explicitly listed resources. Original source files are retained for review, not executed or imported. Legacy registration/result wrappers are not the target entry. Business rules and their unresolved contradictions remain unchanged.\n\nTool schemas are project-defined synthetic ports, NOT recovered original schemas. The original business implementation is missing. Target execution on synthetic data does not establish native equivalence, professional acceptance or Harness/Builder publication.\n');
  }
  const diff=Object.entries(files).filter(([name,bytes])=>!archive[name]||!Buffer.from(bytes).equals(Buffer.from(archive[name]!)))
    .map(([name,bytes])=>({path:name,operation:name in archive?'MODIFY':'ADD',
      before:name in archive?Buffer.from(archive[name]!).toString('utf8'):'',after:Buffer.from(bytes).toString('utf8')}));
  return {files,diff,resources};
}
