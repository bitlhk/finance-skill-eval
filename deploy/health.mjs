import {spawn} from 'node:child_process';
import {args,settings} from './lib/settings.mjs';
const options=args();const config=await settings(options.env);
const child=spawn(config.python,['-B','-m','api.health','--api',options.api||'http://127.0.0.1:'+config.env.FINANCE_EVAL_PORT,'--runtime',options.runtime||'http://127.0.0.1:'+config.env.FINANCE_RUNTIME_PORT],{cwd:config.root,env:config.env,windowsHide:true,stdio:'inherit'});
child.on('error',()=>{process.exitCode=1;});child.on('exit',code=>{process.exitCode=code??1;});
