import {spawn} from 'node:child_process';
import {checkOpenJiuwenEnvironment,openJiuwenEnvironment,projectRoot} from './openjiuwen-environment.mjs';

export function runPythonModule(module,args=process.argv.slice(2)){
  if(args[0]==='--')args=args.slice(1);
  const {python}=checkOpenJiuwenEnvironment();
  const child=spawn(python,['-B','-m',module,...args],{cwd:projectRoot,
    env:openJiuwenEnvironment(process.env),windowsHide:true,stdio:'inherit'});
  child.on('error',()=>{process.exitCode=1;});
  child.on('exit',code=>{process.exitCode=code??1;});
  return child;
}
