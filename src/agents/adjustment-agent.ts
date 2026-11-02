import {prepareModelRole} from './model-role.js';
import {z} from 'zod';
import type {ModelAdapter} from '../adapters.js';
import type {ModelRef} from '../contracts.js';
import type {RoleCallOptions, AdjustmentProposal, AgentAbstention} from './ports.js';
import {loadAgentRole, type AdjustmentCapability} from './composition.js';
import {boundedAgentCall} from './bounded-call.js';

const safePath=z.string().min(1).refine(p=>!p.startsWith('/')&&!p.includes('\\')&&!p.includes(':')
  &&p.split('/').every(part=>part!==''&&part!=='.'&&part!=='..'),'Unsafe candidate path');
const inputSchema=z.strictObject({
  constraints:z.string().optional(),files:z.record(safePath,z.string()),
  permissions:z.strictObject({
    documents:z.strictObject({skillPaths:z.array(safePath),referencePrefixes:z.array(safePath)}).optional(),
    tools:z.array(z.strictObject({toolId:z.string().min(1),paths:z.array(safePath).min(1)})).min(1).optional(),
  }),
  developmentEvidence:z.array(z.strictObject({task:z.string(),answer:z.string(),review:z.string().optional(),
    dimensions:z.unknown().optional(),goalAssessment:z.unknown().optional()})),
});
export type AdjustmentInput=z.infer<typeof inputSchema>;
export type AdjustmentResult=AgentAbstention|{status:'PRODUCED';proposal:AdjustmentProposal};
export type AdjustmentAgent=(input:AdjustmentInput,options:RoleCallOptions)=>Promise<AdjustmentResult>;
const proposalSchema=z.strictObject({summary:z.string().min(1).max(4000),findings:z.array(z.string().max(1500)).min(1).max(8),
  changes:z.array(z.strictObject({path:safePath,content:z.string().min(1).max(128000),reason:z.string().min(1).max(2000)})).min(1).max(9)});
const abstentionSchema=z.strictObject({status:z.literal('ABSTAINED'),reason:z.string().trim().min(1)});
const toolExtension=/\.(?:py|js|mjs|cjs|ts|java|json|toml|ya?ml|txt)$/iu;
const documentPath=(p:string)=>/(^|\/)SKILL\.md$/u.test(p)||/(^|\/)references\/[a-zA-Z0-9_/-]+\.md$/u.test(p);

/** One adjustment role, one context, one proposal, with composable guidance and caller-owned permissions.
 * Proposal execution has no filesystem tools. The application validates and freezes its candidate.
 * Engineering execution uses the same role resources with the OpenJiuwen execution profile. */
export function createAdjustmentAgent(dependencies:{adapter:ModelAdapter;model:ModelRef}):AdjustmentAgent{
  return async(input,options)=>boundedAgentCall(options,async signal=>{
    const safe=inputSchema.parse(input),{documents,tools}=safe.permissions;
    const capabilities:AdjustmentCapability[]=[];
    if(documents)capabilities.push('document');
    if(tools)capabilities.push('tool');
    if(!capabilities.length)throw new Error('Adjustment requires explicit permissions');
    if(documents&&(documents.skillPaths.some(p=>!/(^|\/)SKILL\.md$/u.test(p))
      ||documents.referencePrefixes.some(p=>!/(^|\/)references$/u.test(p))))throw new Error('Invalid document permissions');
    if(tools&&new Set(tools.map(t=>t.toolId)).size!==tools.length)throw new Error('Duplicate tool permission');
    const toolPaths=new Map<string,string[]>();
    for(const tool of tools??[])for(const p of tool.paths){
      if(!Object.hasOwn(safe.files,p)||!toolExtension.test(p)||documentPath(p))throw new Error('Invalid tool permissions');
      toolPaths.set(p,[...new Set([...(toolPaths.get(p)??[]),tool.toolId])]);
    }
    const composition=loadAgentRole('adjustment',options.version,{execution:'proposal',capabilities});
    const roleCall=await prepareModelRole(composition,safe,options,dependencies,signal);
    const completion=await roleCall.complete(safe);
    const output:unknown=JSON.parse(completion.content.replace(/^```(?:json)?\s*|\s*```$/gu,''));
    const abstained=abstentionSchema.safeParse(output);
    if(abstained.success)return abstained.data;
    const proposal=proposalSchema.parse(output),seen=new Set<string>(),toolCounts=new Map<string,number>();
    let documentCount=0;
    for(const change of proposal.changes){
      if(seen.has(change.path))throw new Error('Duplicate adjustment path');
      seen.add(change.path);
      const isDocument=documents&&documentPath(change.path)&&(documents.skillPaths.includes(change.path)
        ||documents.referencePrefixes.some(prefix=>change.path.startsWith(prefix+'/')));
      if(isDocument){
        if(++documentCount>6||change.content.length>80000)throw new Error('Document adjustment exceeds budget');
      }else{
        const owners=toolPaths.get(change.path);
        if(!owners)throw new Error('Adjustment path outside authorized scope');
        for(const toolId of owners){
          const count=(toolCounts.get(toolId)??0)+1;toolCounts.set(toolId,count);
          if(count>3)throw new Error('Tool adjustment exceeds budget');
        }
      }
    }
    return {status:'PRODUCED',proposal};
  });
}
