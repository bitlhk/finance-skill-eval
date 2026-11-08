import type {BundleTask,BundleConfiguration} from '../../../../contracts/platform/responses';
type InputTask=Pick<BundleTask,'analysis'>;
type InputConfiguration=Pick<BundleConfiguration,'runtimeInputs'>;
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
