import {z} from 'zod';

const reference=z.string().min(1).max(300);
export const evaluationCheckSchema=z.strictObject({
  id:z.string().min(1).max(100),version:z.string().min(1).max(100),
  kind:z.enum(['RULE','SCRIPT','STATE']),
  required:z.boolean().default(true),
  evidenceRefs:z.array(reference).max(32).default([]),
  timeoutMs:z.number().int().min(100).max(120000).default(60000),
  rule:z.discriminatedUnion('operation',[
    z.strictObject({operation:z.literal('equals'),reference,expected:z.unknown()}),
    z.strictObject({operation:z.literal('contains'),reference,expected:z.string()}),
    z.strictObject({operation:z.literal('exists'),reference}),
    z.strictObject({operation:z.literal('numeric_tolerance'),reference,expected:z.number().finite(),absoluteTolerance:z.number().finite().nonnegative(),relativeTolerance:z.number().finite().nonnegative().default(0)}),
    z.strictObject({operation:z.literal('set_equals'),reference,expected:z.array(z.union([z.string(),z.number().finite(),z.boolean()])).max(1000)}),
  ]).optional(),
  script:z.string().min(1).max(32000).optional(),
}).superRefine((value,ctx)=>{
  if(value.rule?.operation==='equals'&&!Object.hasOwn(value.rule,'expected'))ctx.addIssue({code:'custom',message:'equals requires an expected value'});
  if(value.kind==='RULE' ? (!value.rule||value.script!==undefined) : (!value.script||value.rule!==undefined))
    ctx.addIssue({code:'custom',message:'RULE requires a rule; SCRIPT/STATE require a Python verifier'});
});
export const evaluationPlanSchema=z.strictObject({
  version:z.string().min(1).max(100),
  answerEvidence:z.array(z.strictObject({
    id:z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
    reference:z.string().max(300).regex(/^\/(state\/.+|toolEvidence\/\d+\/result\/.+)$/),
  })).max(32).optional(),
  checks:z.array(evaluationCheckSchema).max(20),
}).superRefine((plan,ctx)=>{
  if(new Set(plan.checks.map(c=>c.id)).size!==plan.checks.length)ctx.addIssue({code:'custom',message:'Duplicate evaluation check ID'});
  if(plan.answerEvidence&&new Set(plan.answerEvidence.map(c=>c.id)).size!==plan.answerEvidence.length)ctx.addIssue({code:'custom',message:'Duplicate answer evidence ID'});
});
