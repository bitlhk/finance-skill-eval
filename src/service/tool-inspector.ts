import { SCAN_COMPLETE_STATUSES, type Diagnosis } from '../migration/infrastructure/migration-diagnostics.js';
import type { ProjectInspection } from '../migration/domain/migration-model.js';
import { validateSkill } from './skill-validator.js';

/**
 * The rules path: the Skill-spec check plus coverage. It answers "is this package well-formed,
 * and what did the scanner fail to read".
 *
 * It deliberately does **not** discover Tools or read their input/output. Every rule-based
 * attempt to do that ended up inventing something the source never declared: backticked words
 * from prose became Tools, `inputSchema :=` literals became contracts, function names became
 * shapes. Reading a package is a judgement about what its tools *are*, and the analysis is where
 * that judgement lives -- with the agent, where each claim has to land on a real line.
 *
 * Without the analysis there is no baseline, and a migration has nothing to preserve. So this
 * returns `tools: []` rather than a guess, and the caller refuses to treat that as "no tools".
 */
export function inspectProject(input:{assetId:string;assetDigest:string;files:Record<string,string>;skillFile:string;diagnosis?:Diagnosis|null}):ProjectInspection{
  const skill=validateSkill(input.files,input.skillFile);
  const incompleteFiles=input.diagnosis?[...input.diagnosis.coverage
    .filter(item=>!SCAN_COMPLETE_STATUSES.includes(item.status))
    .map(item=>({path:item.path,status:item.status})),
    ...input.diagnosis.findings.filter(item=>item.layer==='UNKNOWN').map(item=>({path:item.path,status:item.dependencyType}))
  ].filter((item,index,all)=>all.findIndex(other=>other.path===item.path&&other.status===item.status)===index):[];
  return {assetId:input.assetId,assetDigest:input.assetDigest,inspectedAt:new Date().toISOString(),skill,tools:[],scriptsExecuted:false,
    staticAnalysis:input.diagnosis?{status:input.diagnosis.status,dependencyStatus:input.diagnosis.dependencyStatus,
      scannerDigest:input.diagnosis.scannerDigest,incompleteFiles,toolIncompleteFiles:[]}
      :{status:'UNAVAILABLE',dependencyStatus:'UNKNOWN',scannerDigest:null,incompleteFiles:[],toolIncompleteFiles:[]},
    runtimeAnalysis:input.diagnosis?{status:input.diagnosis.ai.status,model:input.diagnosis.ai.model,
      acceptedBindings:input.diagnosis.ai.acceptedRuntimeBindings??0,rejectedBindings:input.diagnosis.ai.rejectedRuntimeBindings??0,
      inputTruncated:input.diagnosis.ai.inputTruncated}:undefined};
}
