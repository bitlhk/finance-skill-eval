import {z} from 'zod';
import {canonicalSha256} from '../json-canonicalization.js';

const digest=z.string().regex(/^[a-f0-9]{64}$/u);
export const nativeToolCatalogSchema=z.strictObject({
  schemaVersion:z.literal('finance.native-tool-catalog.v1'),
  runtime:z.strictObject({type:z.enum(['openjiuwen','agentscope']),version:z.string().min(1)}),
  deploymentId:z.string().min(1),artifactSha256:digest,
  contracts:z.array(z.strictObject({capabilityId:z.string().min(1),
    nativeToolNames:z.array(z.string().min(1)).min(1),verificationSha256:digest,
    contract:z.strictObject({inputSchema:z.record(z.unknown()),outputSchema:z.record(z.unknown()),
      errorSchema:z.record(z.unknown()),semantics:z.string().min(1)}),
    constraints:z.strictObject({permissions:z.array(z.string()),sideEffects:z.enum(['none','read']),isolation:z.string().min(1)}),
  })).max(64),catalogDigest:digest,
}).superRefine((value,context)=>{
  const {catalogDigest,...body}=value;
  if(canonicalSha256(body)!==catalogDigest)context.addIssue({code:'custom',message:'原生工具目录摘要不一致'});
  const names=value.contracts.flatMap(item=>item.nativeToolNames);
  if(new Set(names).size!==names.length)context.addIssue({code:'custom',message:'原生工具名称冲突'});
});
export type NativeToolCatalog=z.infer<typeof nativeToolCatalogSchema>;
export type NativeBindingTarget={environmentId:string;catalog:NativeToolCatalog};
export type NativeSkillBindings={
  schemaVersion:'finance.native-skill-bindings.v1';sourceDigest:string;
  targets:Array<{environmentId:string;runtime:NativeToolCatalog['runtime'];catalogDigest:string;artifactSha256:string}>;
  tools:Array<{name:string;contractDigest:string;constraintsDigest:string}>;
};
