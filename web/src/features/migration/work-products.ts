export type WorkProductEvent = {sequence:number;kind:string;payload:unknown};
export type WorkProductVersion = {sequence:number;title:string;content:string;workspaceDigest?:string;reviewStability?:'frozen'|'stable_boundaries'|'changed'|'unverified'};

/** Project the append-only conversation into products without losing history. */
export function workProducts(events:WorkProductEvent[]):Map<string,WorkProductVersion[]> {
  const products=new Map<string,WorkProductVersion[]>();
  for(const event of events){
    if(event.kind!=='work_product'||!event.payload||typeof event.payload!=='object')continue;
    const value=event.payload as Record<string,unknown>;
    if(typeof value.id!=='string'||typeof value.title!=='string'||typeof value.content!=='string')continue;
    const versions=products.get(value.id)??[];
    versions.push({sequence:event.sequence,title:value.title,content:value.content,
      ...(typeof value.workspaceDigest==='string'?{workspaceDigest:value.workspaceDigest}:{}),
      ...(['frozen','stable_boundaries','changed','unverified'].includes(String(value.reviewStability))?{reviewStability:value.reviewStability as WorkProductVersion['reviewStability']}:{})});products.set(value.id,versions);
  }
  return products;
}
