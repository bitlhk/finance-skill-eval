/** Run the deterministic four-fixture checks without model calls or credentials. */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root=process.cwd();
const configured=process.env.FINANCE_EVAL_MIGRATION_PYTHON;
const candidates=[
  configured,
  path.join(root,'.venv-openjiuwen','Scripts','python.exe'),
  path.join(root,'integrations','openjiuwen','.venv','bin','python'),
].filter(Boolean);
const python=candidates.find(candidate=>existsSync(candidate));
if(!python){
  throw new Error('OpenJiuwen Python environment is missing. Run `uv sync --project integrations/openjiuwen --frozen` or set FINANCE_EVAL_MIGRATION_PYTHON.');
}

function run(program,args){
  const result=spawnSync(program,args,{cwd:root,env:process.env,stdio:'inherit'});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status??1);
}

run(process.execPath,['--import','tsx','acceptance/enterprise-migration-examples/verify_formats.mjs']);
run(python,['-B','acceptance/enterprise-migration-examples/verify_examples.py']);
run(python,['-B','acceptance/enterprise-migration-examples/verify_mcp_examples.py']);
