import {z} from 'zod';

const text=z.string().trim().min(1);
const evidence=z.object({path:text,snippet:text});
const members={memberIds:z.array(text)};
/** The diagnosis is the user's change inventory, not a second migration workflow. */
export const taskDiagnosisSchema=z.object({
  skillChanges:z.array(z.object({...members,paths:z.array(text).min(1),action:z.enum(['KEEP','UPDATE']),reason:text})),
  tools:z.array(z.object({...members,id:text,name:text,sourcePaths:z.array(text).min(1),
    currentBehavior:text,problem:text,targetForm:z.enum(['MCP','SCRIPT','KEEP','UNCONFIRMED']),language:text,reason:text,
    changes:z.array(z.object({title:text,before:text,after:text,steps:z.array(text).min(1)})),
    preservedBehavior:z.array(text),
    callChain:z.array(z.object({title:text,detail:text,evidence:z.array(evidence).min(1)})),
    evidence:z.array(evidence).min(1),
  })),
  dependencies:z.array(z.object({id:text,name:text,toolIds:z.array(text),
    owner:z.enum(['RUNTIME','TOOL','UNKNOWN']),action:z.enum(['INJECT','PACKAGE','MOVE_TO_RUNTIME','KEEP','CONFIRM']),
    purpose:text,configuration:text,verification:text,evidence:z.array(evidence).min(1),
  })),
});
export type TaskDiagnosis=z.infer<typeof taskDiagnosisSchema>;
