/** Run the deterministic four-fixture checks without model calls or credentials. */
import {checkOpenJiuwenEnvironment,projectRoot} from './lib/openjiuwen-environment.mjs';
import { spawnSync } from 'node:child_process';
const root=projectRoot;
const {python}=checkOpenJiuwenEnvironment();

function run(program,args){
  const result=spawnSync(program,args,{cwd:root,env:process.env,stdio:'inherit'});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status??1);
}

run(process.execPath,['--import','tsx','acceptance/enterprise-migration-examples/verify_formats.mjs']);
run(python,['-B','acceptance/enterprise-migration-examples/verify_examples.py']);
run(python,['-B','acceptance/enterprise-migration-examples/test_improvement_cases.py']);
run(python,['-B','acceptance/enterprise-migration-examples/verify_mcp_examples.py']);
