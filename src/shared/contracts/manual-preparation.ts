import { z } from 'zod';
import { evalCaseSchema } from '../../contracts.js';

export const manualPreparationSchema = z.strictObject({
  summary: z.string().min(1).max(2_000),
  cases: z.array(evalCaseSchema.omit({ replay: true })).min(1).max(8),
  holdoutCases: z.array(evalCaseSchema.omit({ replay: true })).max(8).default([]),
}).superRefine((value,context)=>{
  const ids=[...value.cases,...value.holdoutCases].map(c=>c.caseId);
  if (new Set(ids).size!==ids.length) context.addIssue({code:z.ZodIssueCode.custom,message:'Development and holdout case IDs must be disjoint and unique'});
});
