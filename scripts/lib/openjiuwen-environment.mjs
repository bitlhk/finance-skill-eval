import {existsSync,readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const projectRoot=fileURLToPath(new URL('../../',import.meta.url));
export function projectPython(root=projectRoot,platform=process.platform){
  return path.join(root,'.venv-openjiuwen',platform==='win32'?'Scripts/python.exe':'bin/python');
}
export function openJiuwenEnvironment(env=process.env){
  // Child services inherit the explicitly selected interpreter, never a user-site SDK.
  const child={...env,PYTHONUTF8:'1',PYTHONUNBUFFERED:'1',PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1',
    PYTHONPATH:[path.join(projectRoot,'src'),projectRoot,env.PYTHONPATH].filter(Boolean).join(path.delimiter)};
  delete child.PYTHONHOME;
  return child;
}
export function resolveOpenJiuwenPython({root=projectRoot,env=process.env,platform=process.platform}={}){
  const configured=env.FINANCE_EVAL_MIGRATION_PYTHON?.trim();
  if(configured&&!path.isAbsolute(configured))throw new Error('FINANCE_EVAL_MIGRATION_PYTHON must be an absolute path');
  const python=configured||projectPython(root,platform);
  if(!existsSync(python))throw new Error('Project OpenJiuwen environment is missing. Run pnpm setup:openjiuwen. No system Python fallback is allowed.');
  return python;
}
export function checkOpenJiuwenEnvironment({root=projectRoot,env=process.env}={}){
  const python=resolveOpenJiuwenPython({root,env});
  const result=spawnSync(python,['-B',path.join(root,'integrations/openjiuwen/environment_check.py')],
    {cwd:root,env:openJiuwenEnvironment(env),encoding:'utf8',timeout:10_000,windowsHide:true});
  if(result.error)throw new Error('Unable to check the project Python environment: '+result.error.message);
  let report;
  try{report=JSON.parse(result.stdout);}catch{throw new Error('Project Python did not return a valid environment check; run pnpm setup:openjiuwen.');}
  if(result.status!==0||report.ok!==true)throw new Error(report.error??'OpenJiuwen environment check failed');
  return {python,report};
}
export function validateRuntimeConfiguration(file){
  try{
    const {models}=JSON.parse(readFileSync(file,'utf8'));
    if(!models||typeof models!=='object'||Array.isArray(models)||!Object.keys(models).length
      ||Object.values(models).some(model=>!model||['baseUrl','apiKey','upstreamModelId'].some(key=>
        typeof model[key]!=='string'||!model[key]||model[key].startsWith('REPLACE_WITH_'))))throw new Error();
  }catch{
    // A JSON parser's message can contain private configuration text. Never echo it.
    throw new Error('Runtime configuration is missing or invalid. Complete the model bindings in .runtime.local.json or FINANCE_RUNTIME_CONFIG.');
  }
}
