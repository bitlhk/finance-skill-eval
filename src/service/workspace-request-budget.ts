export type WorkspaceRequestLimits={perAccount:number;global:number;windowSeconds:number};
type Refusal={scope:'ACCOUNT'|'SERVICE';retryAfterSeconds:number};

/** Admission rate, not a monetary quota or a count of underlying model attempts. */
export class WorkspaceRequestBudget {
  private entries:Array<{subject:string;at:number}>=[];
  constructor(private readonly limits:WorkspaceRequestLimits,
    private readonly now:()=>number=()=>performance.now()){
    if(!Number.isInteger(limits.perAccount)||limits.perAccount<1
      ||!Number.isInteger(limits.global)||limits.global<limits.perAccount||limits.global>10000
      ||!Number.isInteger(limits.windowSeconds)||limits.windowSeconds<1||limits.windowSeconds>86400)
      throw new Error('WORKSPACE_REQUEST_BUDGET_INVALID');
  }
  take(subject:string):Refusal|null{
    const now=this.now(),window=this.limits.windowSeconds*1000;
    this.entries=this.entries.filter(entry=>entry.at>now-window);
    const retry=(at:number)=>Math.max(1,Math.ceil((at+window-now)/1000));
    if(this.entries.length>=this.limits.global)
      return {scope:'SERVICE',retryAfterSeconds:retry(this.entries[0]!.at)};
    const account=this.entries.filter(entry=>entry.subject===subject);
    if(account.length>=this.limits.perAccount)
      return {scope:'ACCOUNT',retryAfterSeconds:retry(account[0]!.at)};
    this.entries.push({subject,at:now});return null;
  }
}

function routePath(url:string){
  try{return decodeURIComponent(new URL(url,'http://workspace.invalid').pathname);}catch{return null;}
}

export function isWorkspacePreflight(method:string,url:string):boolean{
  return method==='POST'&&/^\/api\/environments\/[^/]+\/preflight\/?$/u.test(routePath(url)??'');
}

export function requiresWorkspaceBudget(method:string,url:string):boolean{
  const route=routePath(url);
  if(route===null)return true;
  // Capability inspection does not build an Agent or execute a model/tool.
  // It has a separate bounded allowance so UI preflight cannot starve a run.
  if(isWorkspacePreflight(method,url))return false;
  if(method==='OPTIONS')return false;
  if(method==='GET'||method==='HEAD'){
    // These existing read endpoints may initialize missing model-assisted diagnostics.
    return /^\/api\/migrations\/[^/]+\/(diagnosis|inspection|report|export)\/?$/u.test(route);
  }
  // A saturated ingress must not prevent resource reclamation. Optimization
  // decisions only adopt/retain/cancel existing results; they start no model work.
  if(method==='POST'&&(/^\/api\/runs\/[^/]+\/cancel\/?$/u.test(route)
    ||/^\/api\/optimizations\/[^/]+\/decision\/?$/u.test(route)))return false;
  return true;
}
