import {z} from 'zod';
const sourceId=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/);

export const reviewSourceSchema=z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('migration'),id:sourceId,runId:sourceId}),
  z.strictObject({kind:z.literal('comparison'),id:sourceId}),
]);
export type ReviewSource=z.infer<typeof reviewSourceSchema>;
const outcomeSchema=z.enum(['PASS','FAIL','UNVERIFIED','left','right','tie']);
export const reviewEntrySchema=z.strictObject({
  targetId:z.string().min(1).max(300),reviewer:z.string().trim().min(1).max(100),
  kind:z.enum(['ANNOTATION','ADJUDICATION']).default('ANNOTATION'),
  outcome:outcomeSchema,reason:z.string().trim().min(1).max(4000),
  evidenceRefs:z.array(z.string().min(1).max(500)).min(1).max(32),
  supersedes:z.string().uuid().optional(),resolves:z.array(z.string().uuid()).max(100).default([]),
});
export const reviewImportSchema=z.strictObject({source:reviewSourceSchema,sourceDigest:z.string().regex(/^[a-f0-9]{64}$/),
  entries:z.array(reviewEntrySchema).min(1).max(200)});
export type HumanReview=z.infer<typeof reviewEntrySchema>&{id:string;createdAt:string;sourceDigest:string};
export type ReviewTarget={id:string;caseId:string;label:string;scope:'case'|'criterion'|'pairwise'|'method';
  machine:string|null;outcomes:Array<z.infer<typeof outcomeSchema>>;evidenceRoot:string};

export function reviewConsensus(target:ReviewTarget,records:HumanReview[]){
  const scoped=records.filter(r=>r.targetId===target.id);
  const replaced=new Set(scoped.map(r=>r.supersedes).filter(Boolean));
  const annotations=scoped.filter(r=>r.kind==='ANNOTATION'&&!replaced.has(r.id));
  const ids=annotations.map(r=>r.id).sort();
  const decision=[...scoped].reverse().find(r=>r.kind==='ADJUDICATION'&&ids.length>0&&JSON.stringify([...r.resolves].sort())===JSON.stringify(ids));
  const values=[...new Set(annotations.map(r=>r.outcome))];
  return {annotations,decision,outcome:decision?.outcome??(values.length===1?values[0]:null),
    disputed:!decision&&values.length>1};
}

/** Agreement on annotated decisions, not dataset accuracy or automatic acceptance. */
export function calibrationSummary(targets:ReviewTarget[],records:HumanReview[]){
  return (['case','criterion','pairwise','method'] as const).map(scope=>{
    const selected=targets.filter(t=>t.scope===scope);
    let reviewed=0,disputed=0,comparable=0,agree=0,machineMissing=0,humanUnverified=0;
    for(const target of selected){
      const result=reviewConsensus(target,records);
      if(!result.annotations.length)continue;
      reviewed++;
      if(result.disputed){disputed++;continue;}
      if(result.outcome==='UNVERIFIED'||!result.outcome){humanUnverified++;continue;}
      if(target.machine===null){machineMissing++;continue;}
      comparable++;if(result.outcome===target.machine)agree++;
    }
    return {scope,total:selected.length,reviewed,unreviewed:selected.length-reviewed,disputed,comparable,agree,
      disagree:comparable-agree,machineMissing,humanUnverified,agreement:comparable?agree/comparable:null};
  });
}
