import { z } from 'zod';

const endpointSchema=z.string().url().refine(value=>{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&!url.hash;},'Use an HTTP(S) endpoint without embedded credentials or fragments');
const baseUrlSchema=endpointSchema.refine(value=>{const url=new URL(value);return url.protocol==='https:'||['127.0.0.1','localhost','::1'].includes(url.hostname);},'Remote Runtime Launcher requires HTTPS').transform(value=>{const url=new URL(value);if(url.search)throw new Error('Runtime Launcher base URL cannot include a query');if(!url.pathname.endsWith('/'))url.pathname+='/';return url.toString();});
const common={name:z.string().trim().min(1).max(80),credentialEnv:z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u).max(100).nullable().optional()};
const legacyMcp=z.strictObject({...common,type:z.literal('mcp_streamable_http'),runtimeType:z.null().optional(),endpoint:endpointSchema,mcpEnvironmentIds:z.array(z.string().min(1)).max(0).default([])});
const legacyRuntime=z.strictObject({...common,type:z.literal('runtime_http'),runtimeType:z.enum(['openjiuwen','ea','generic_http']).nullable().optional(),endpoint:endpointSchema,mcpEnvironmentIds:z.array(z.string().min(1)).max(12).default([])});
const launcher=z.strictObject({...common,type:z.literal('runtime_launcher'),runtimeType:z.enum(['openjiuwen','ea','generic_http']),baseUrl:baseUrlSchema});
const executionEnvironment=z.strictObject({name:z.string().trim().min(1).max(80),type:z.literal('execution_environment'),launcherEnvironmentId:z.string().min(1),mcpEnvironmentIds:z.array(z.string().min(1)).max(12).default([]),defaultModelId:z.string().min(1).nullable().optional()});
export const createEnvironmentSchema=z.union([legacyMcp,legacyRuntime,launcher,executionEnvironment]).superRefine((value,context)=>{
  if('mcpEnvironmentIds' in value&&new Set(value.mcpEnvironmentIds).size!==value.mcpEnvironmentIds.length)context.addIssue({code:'custom',message:'Duplicate MCP bindings'});
});

const recordCommon={environmentId:z.string().min(1),name:z.string().min(1),credentialEnv:z.string().min(1).nullable().default(null),createdAt:z.string().datetime(),updatedAt:z.string().datetime()};
export const environmentRecordSchema=z.union([
  z.strictObject({...recordCommon,type:z.literal('mcp_streamable_http'),runtimeType:z.null().default(null),endpoint:z.string().url(),mcpEnvironmentIds:z.array(z.string().min(1)).default([])}),
  z.strictObject({...recordCommon,type:z.literal('runtime_http'),runtimeType:z.enum(['openjiuwen','ea','generic_http']).nullable().default(null),endpoint:z.string().url(),mcpEnvironmentIds:z.array(z.string().min(1)).default([])}),
  z.strictObject({...recordCommon,type:z.literal('runtime_launcher'),runtimeType:z.enum(['openjiuwen','ea','generic_http']),baseUrl:z.string().url()}),
  z.strictObject({environmentId:z.string().min(1),name:z.string().min(1),type:z.literal('execution_environment'),runtimeType:z.null().default(null),launcherEnvironmentId:z.string().min(1),mcpEnvironmentIds:z.array(z.string().min(1)).default([]),defaultModelId:z.string().min(1).nullable().default(null),createdAt:z.string().datetime(),updatedAt:z.string().datetime()}),
]);
export type EnvironmentRecord=z.infer<typeof environmentRecordSchema>;
