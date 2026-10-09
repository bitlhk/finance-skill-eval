import type {MigrationReusePlanner} from '../application/migration-reuse-planner.js';
import type {ProjectInspection} from '../domain/migration-model.js';

function inspectionFacts(value:ProjectInspection){
  return {tools:value.tools.map(({name,sourcePaths,portability,inputSchema,outputSchema,entrypoint})=>
    ({name,sourcePaths,portability,inputSchema,outputSchema,entrypoint})),
    dependencies:value.dependencyAnalysis?.dependencies.map(({key,name,owner,action,purpose,schema,binding,resolvedPaths,contractStatus,blocking,sensitive})=>
      ({key,name,owner,action,purpose,schema,binding,resolvedPaths,contractStatus,blocking,sensitive})),
    runtimeCapabilities:value.runtimeCapabilities?.map(({name,reason,usageContract,contract,constraints,consumerTools})=>
      ({name,reason,usageContract,contract,constraints,consumerTools}))};
}

/** Focus the review on changed files without hiding surrounding code or new dependencies.
 * Exact shared content is sent once with both path sets; nothing is truncated or guessed. */
export function reuseModelContext(input:Parameters<MigrationReusePlanner>[0]){
  if(input.mode==='PROPOSE')return input;
  const shared=new Map<string,{sourcePaths:string[];candidatePaths:string[];content:string}>();
  for(const [path,content] of Object.entries(input.sourceFiles)){
    const group=shared.get(content)??{sourcePaths:[],candidatePaths:[],content};group.sourcePaths.push(path);shared.set(content,group);
  }
  const changedCandidateFiles:Array<{path:string;sourcePath:string|null;content:string}>=[];
  for(const [path,content] of Object.entries(input.candidateFiles)){
    const group=shared.get(content);
    if(group){group.candidatePaths.push(path);continue;}
    const sourcePath=Object.hasOwn(input.sourceFiles,path)?path
      :path.startsWith('skill/')&&Object.hasOwn(input.sourceFiles,path.slice(6))?path.slice(6):null;
    changedCandidateFiles.push({path,sourcePath,content});
  }
  return {mode:'REVIEW',design:input.design,deliveryContract:input.deliveryContract,
    focus:'Compare actual changes against the approved design. Shared code remains available for imports, state, isolation and hidden dependency review.',
    sourceFacts:inspectionFacts(input.sourceInspection),candidateFacts:inspectionFacts(input.candidateInspection),
    changedCandidateFiles,
    sharedFiles:[...shared.values()].filter(group=>group.candidatePaths.length),
    sourceOnlyContent:[...shared.values()].filter(group=>!group.candidatePaths.length).map(({sourcePaths,content})=>({sourcePaths,content})),
  };
}
