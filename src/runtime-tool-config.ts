import {z} from 'zod';

const contextField=z.strictObject({type:z.enum(['string','object','array','number','boolean']),value:z.unknown().optional(),env:z.string().min(1).optional(),sensitive:z.boolean().default(true)}).superRefine((v,c)=>{
  if(Object.prototype.hasOwnProperty.call(v,'value')===Boolean(v.env))c.addIssue({code:z.ZodIssueCode.custom,message:'Context requires exactly one of value or env'});
});
/** References are dotted paths rooted at context, e.g. context.user.id. */
const reference=z.string().regex(/^context\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u);
const headerName=z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u).refine(name=>! /^(host|content-length|connection|transfer-encoding|content-type|accept|mcp-session-id|mcp-protocol-version)$/iu.test(name),'Reserved transport header');
export const runtimeToolConfigSchema=z.strictObject({
  context:z.record(contextField).default({}),
  providers:z.record(z.strictObject({implementation:z.string().min(1),inputs:z.record(reference)})).default({}),
  tools:z.record(z.strictObject({contextBindings:z.record(headerName,reference).default({}),authProvider:z.string().min(1).optional()})).default({}),
}).superRefine((config,ctx)=>{
 for(const [name,tool] of Object.entries(config.tools)){
  if(tool.authProvider&&!config.providers[tool.authProvider])ctx.addIssue({code:z.ZodIssueCode.custom,path:['tools',name,'authProvider'],message:'Unknown auth provider'});
  const names=Object.keys(tool.contextBindings).map(key=>key.toLowerCase());
  if(new Set(names).size!==names.length)ctx.addIssue({code:z.ZodIssueCode.custom,path:['tools',name,'contextBindings'],message:'Duplicate context header'});
 }
});
export type RuntimeToolConfig=z.infer<typeof runtimeToolConfigSchema>;
