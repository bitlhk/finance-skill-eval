import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {checkOpenJiuwenEnvironment,openJiuwenEnvironment,projectPython,projectRoot,validateRuntimeConfiguration} from './lib/openjiuwen-environment.mjs';

function run(program,args,env=process.env){
  const result=spawnSync(program,args,{cwd:projectRoot,env:openJiuwenEnvironment(env),stdio:'inherit',windowsHide:true});
  if(result.error)throw result.error;
  if(result.status!==0)throw new Error(`${path.basename(program)} exited with ${result.status??result.signal}`);
}
const defaultTests=['discover','-s','tests','-p','test_*.py'];
try{
  const args=process.argv.slice(2).filter((value,index)=>!(index===0&&value==='--'));
  const setup=args[0]==='--setup'||(args[0]==='--serve'&&args[1]==='--setup');
  const serve=args[0]==='--serve'||(args[0]==='--setup'&&args[1]==='--serve');
  if(setup){
    if(args.some(a=>!['--setup','--serve'].includes(a)))throw new Error('--setup only accepts optional --serve');
    const configured=process.env.FINANCE_EVAL_MIGRATION_PYTHON?.trim();
    if(configured&&path.resolve(configured)!==projectPython())throw new Error('Setup only manages .venv-openjiuwen. Clear the external FINANCE_EVAL_MIGRATION_PYTHON override before setup.');
    run('uv',['sync','--locked','--project',path.join(projectRoot,'integrations/openjiuwen'),
      '--python',process.env.FINANCE_OPENJIUWEN_PYTHON?.trim()||'3.12','--no-dev','--link-mode','copy'],
    {...process.env,UV_PROJECT_ENVIRONMENT:path.join(projectRoot,'.venv-openjiuwen')});
  }
  const {python,report}=checkOpenJiuwenEnvironment();
  if(serve){
    if(args.some(a=>!['--setup','--serve'].includes(a)))throw new Error('--serve only accepts optional --setup');
    const configuration=path.resolve(projectRoot,process.env.FINANCE_RUNTIME_CONFIG||'.runtime.local.json');
    validateRuntimeConfiguration(configuration);
    run(python,['-B','-m','uvicorn','integrations.openjiuwen.worker:app','--host','127.0.0.1','--port','56362'],
      {...process.env,FINANCE_RUNTIME_CONFIG:configuration});
  }else if(args[0]==='--test'){
    run(python,['-B','-m','unittest',...(args.length>1?args.slice(1):defaultTests)]);
  }else if(!args.length||args[0]==='--check'||setup){
    console.log(JSON.stringify(report,null,2));
  }else{
    run(python,['-B',...args]);
  }
}catch(error){console.error(error.message);process.exitCode=1;}
