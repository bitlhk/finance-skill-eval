import {z} from 'zod';
import {validServiceEnvironmentName} from '../../../shared/contracts/service-environment.js';

export const toolEnvironmentName=z.string().refine(name=>validServiceEnvironmentName(name)&&!name.startsWith('FINANCE_'),'无效的工具配置名称');
export const runtimeInputSchema=z.object({name:toolEnvironmentName,label:z.string().min(1),description:z.string().min(1),
  required:z.boolean(),sensitive:z.boolean(),toolIds:z.array(z.string().min(1)).min(1)});
export const runtimeInputGroupSchema=z.object({label:z.string().min(1),alternatives:z.array(z.array(toolEnvironmentName).min(1)).min(1)});
export const runtimeInputValuesSchema=z.record(toolEnvironmentName,z.union([
  z.strictObject({value:z.string().max(8000).refine(value=>!value.includes('\0'))}),
  z.strictObject({secretEnv:z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/)}),
]));
type InputConfiguration={runtimeInputs?:z.infer<typeof runtimeInputValuesSchema>};
type InputTask={analysis?:{standardization?:{configurationInputs?:Array<z.infer<typeof runtimeInputSchema>>;configurationGroups?:Array<z.infer<typeof runtimeInputGroupSchema>>}}};
export function runtimeInputIssues(task:InputTask,configuration:InputConfiguration,requireComplete=false){
  const declared=task.analysis?.standardization?.configurationInputs??[],values=configuration.runtimeInputs??{};
  const issues:string[]=[];
  for(const [name,value] of Object.entries(values)){
    const field=declared.find(f=>f.name===name);
    if(!field)issues.push('配置不在当前方案中：'+name);
    else if(field.sensitive!==('secretEnv' in value))issues.push(field.label+'：凭证需使用安全配置引用，普通配置填写实际值');
  }
  if(requireComplete)for(const field of declared){
    const value=values[field.name];
    if(field.required&&(!value||('value' in value?!value.value.trim():!value.secretEnv.trim())))issues.push('请补充'+field.label+'（'+field.name+'）');
  }
  if(requireComplete)for(const group of task.analysis?.standardization?.configurationGroups??[]){
    if(!group.alternatives.some(option=>option.every(name=>{const value=values[name];return Boolean(value&&('value' in value?value.value.trim():value.secretEnv.trim()));})))
      issues.push('请补充'+group.label+'（任选一组：'+group.alternatives.map(option=>option.map(name=>declared.find(f=>f.name===name)?.label??name).join('、')).join('；或 ')+ '）');
  }
  return issues;
}
export function resolveRuntimeInputs(configuration:InputConfiguration,environ:NodeJS.ProcessEnv=process.env){
  const publicValues:Record<string,string>={},secrets:Record<string,string>={};
  for(const [name,input] of Object.entries(configuration.runtimeInputs??{})){
    if('secretEnv' in input){
      const value=environ[input.secretEnv];
      if(!value?.trim())throw new Error('请由环境维护者配置凭证引用：'+input.secretEnv);
      secrets['tool.env.'+name]=value;
    }else if(input.value.trim())publicValues['tool.env.'+name]=input.value;
  }
  return {publicValues,secrets};
}
