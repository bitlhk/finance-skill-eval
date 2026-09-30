import type {SkillAssetRecord} from '../../shared/contracts/skill-asset.js';
import type {PortableGeneration} from '../domain/migration-candidate-artifact.js';
import {languageOfSourcePaths,type ProjectInspection,type ToolDecision} from '../domain/migration-model.js';
import {inspectProject} from '../domain/migration-project-inspector.js';
import type {MigrationDiagnosisPort} from './migration-diagnosis-port.js';
import {migrationConflict as conflict} from './migration-errors.js';

const CODE_FILE=/\.(?:java|py|js|mjs|cjs|ts)$/iu;

export class MigrationCandidateInspectionService {
  constructor(private readonly diagnostics?:MigrationDiagnosisPort) {}

  async inspect(input:{
    candidate:SkillAssetRecord;
    files:Record<string,Uint8Array>;
    inspection:ProjectInspection;
    decisions:ToolDecision[];
    baseAssetId:string;
    generations:PortableGeneration[];
  }):Promise<ProjectInspection>{
    const decoded:Record<string,string>={};
    for(const [name,bytes] of Object.entries(input.files)){
      try{decoded[name]=new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{}
    }
    if(!this.diagnostics)return conflict('静态诊断服务不可用，不能确认生成候选');
    let diagnosis;
    try{diagnosis=await this.diagnostics.diagnose(input.candidate)}
    catch{return conflict('生成候选的静态诊断执行失败，候选未被采纳；请检查 uv、锁文件和扫描器配置')}
    if(diagnosis.digest!==input.candidate.artifactSha256)return conflict('生成候选的静态诊断与资产不匹配');
    const candidateInspection=inspectProject({assetId:input.candidate.assetId,assetDigest:input.candidate.artifactSha256,
      files:decoded,skillFile:input.candidate.skillFile,diagnosis});
    candidateInspection.dependencyAnalysis=input.inspection.dependencyAnalysis?structuredClone(input.inspection.dependencyAnalysis):undefined;
    candidateInspection.runtimeCapabilities=input.inspection.runtimeCapabilities?structuredClone(input.inspection.runtimeCapabilities):undefined;
    if(candidateInspection.skill.status!=='COMPLIANT'){
      const errors=candidateInspection.skill.findings.filter(item=>item.severity==='ERROR').map(item=>`${item.code}: ${item.message}`).join('；');
      return conflict(`生成候选不符合 Skill 包规范，候选未被采纳：${errors||'Skill 检查未通过'}`);
    }
    candidateInspection.tools=input.inspection.tools.map(tool=>{
      const decision=input.decisions.find(item=>item.toolId===tool.toolId&&item.baseAssetId===input.baseAssetId)!;
      const generation=input.generations.find(item=>item.toolId===tool.toolId)!;
      if(decision.form==='SCRIPT'){
        const entrypoint=generation.entrypoint??generation.files.find(name=>CODE_FILE.test(name))!;
        const sample=tool.samples.find(item=>item.input&&typeof item.input==='object'&&!Array.isArray(item.input))?.input as Record<string,unknown>|undefined;
        const inputSchema=tool.inputSchema??(sample?{type:'object',properties:Object.fromEntries(Object.entries(sample).map(([name,value])=>[name,
          value===null?{}:Array.isArray(value)?{type:'array'}:{type:typeof value==='object'?'object':typeof value}])),additionalProperties:true}:null);
        return {...tool,inputSchema,sourcePaths:[entrypoint],language:languageOfSourcePaths([entrypoint]),kind:'SCRIPT' as const,
          portability:'PORTABLE_SCRIPT' as const,entrypoint:{kind:(/\.py$/iu.test(entrypoint)?'PYTHON':'NODE') as 'PYTHON'|'NODE',path:entrypoint},
          findings:tool.inputSchema||!sample?[]:[{code:'SAMPLE_INPUT_HINTS',severity:'INFO' as const,path:entrypoint,line:1,
            message:'输入字段来自原始样例，仅作调用提示，不是完整源 Schema'}]};
      }
      const generatedFiles=generation.files.filter(name=>CODE_FILE.test(name));
      return {...tool,sourcePaths:generatedFiles,language:languageOfSourcePaths(generatedFiles),kind:'MCP' as const,
        portability:'PORTABLE_MCP' as const,entrypoint:undefined,findings:[]};
    });
    return candidateInspection;
  }
}
