export type RuntimeLibraryInventory={python:{version:string;standardModules:string[];packageDistributions?:Record<string,string[]>}};
export type DependencyLibrary={type:'STANDARD_LIBRARY'|'PACKAGE'|'CUSTOM_SDK'|'UNKNOWN';language:'python'|'node';module:string;packageName?:string;version?:string;declarationPaths?:string[];verified?:boolean;environmentVersion?:string};
export type DependencyEvidence={path:string;line:number;snippet:string};
/** Per-call business inputs are not missing implementation/configuration materials. */
export type ExecutionInput={contract:string;evidence:DependencyEvidence[]};
export type Dependency={library?:DependencyLibrary;executionInput?:ExecutionInput;id:string;key:string;name:string;kind:'DATA'|'SDK'|'CONFIG'|'RESOURCE';owner:'TOOL'|'RUNTIME'|'UNKNOWN';action:'KEEP'|'INJECT'|'MOVE_TO_RUNTIME';contractStatus:'KNOWN'|'UNKNOWN';sensitive:boolean;binding:{kind:'HTTP_HEADER'|'SCRIPT_CONTEXT'|'SERVICE_ENV';name:string}|null;toolIds:string[];purpose:string;availability:'AVAILABLE'|'MISSING'|'UNKNOWN';provided:'NONE'|'PENDING'|'CONFIRMED'|'INVALID';blocking:boolean;evidence:DependencyEvidence[];resolvedPaths:string[];schema:Record<string,unknown>|null;schemaCompleteness:'UNKNOWN'|'PARTIAL'|'COMPLETE';issue?:string};
export function isExecutionInput(dependency:Dependency):boolean {
 return dependency.kind==='DATA'&&dependency.owner==='TOOL'&&dependency.action==='KEEP'
  &&dependency.contractStatus==='KNOWN'&&dependency.binding===null
  &&!!dependency.executionInput?.contract.trim()&&!!dependency.executionInput.evidence.length;
}
/** Migration readiness does not claim that the inputs or target environment are ready to run. */
export function dependencyBlocksMigration(dependency:Dependency):boolean {
 return dependency.blocking&&(dependency.owner==='UNKNOWN'||dependency.contractStatus!=='KNOWN'
  ||dependency.owner==='TOOL'&&(!isExecutionInput(dependency)&&dependency.availability!=='AVAILABLE'||dependency.provided==='INVALID'));
}
export type ToolChain={toolId:string;nodes:Array<{id:string;title:string;detail:string;dependencyIds:string[];evidence:DependencyEvidence[]}>;edges:Array<{from:string;to:string;condition?:string}>};
export type DependencyAnalysis={status:'COMPLETE'|'PARTIAL'|'UNAVAILABLE';revision:number;materialsDigest:string;reason?:string;dependencies:Dependency[];chains:ToolChain[];rejectedClaims:number};
export type Supplement={dependencyId:string;kind:Dependency['kind'];value?:unknown;files?:Record<string,string>;filename?:string;updatedAt:string};
export type AnalysisSupplement={dependencyId:string;key:string;kind:Dependency['kind'];provided:true;paths:string[]};
