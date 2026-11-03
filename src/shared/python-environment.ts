import path from 'node:path';

/** Operator-owned installation paths; never resolved from an uploaded project. */
export function runtimeProjectRoot():string{
  const configured=process.env.FINANCE_EVAL_MIGRATION_PROJECT_ROOT?.trim();
  if(configured&&!path.isAbsolute(configured))throw new Error('MIGRATION_PROJECT_ROOT_MUST_BE_ABSOLUTE');
  return configured||process.env.FINANCE_EVAL_ROOT?.trim()||process.cwd();
}
export function pythonInterpreter(projectRoot:string):string{
  const configured=process.env.FINANCE_EVAL_MIGRATION_PYTHON?.trim();
  if(configured)return configured;
  return process.platform==='win32'?path.join(projectRoot,'.venv-openjiuwen','Scripts','python.exe')
    :path.join(projectRoot,'.venv-openjiuwen','bin','python');
}
