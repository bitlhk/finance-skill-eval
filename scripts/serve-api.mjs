// Development entry: load the checked environment and run the Python service.
import {spawn} from 'node:child_process';
import path from 'node:path';
import {checkOpenJiuwenEnvironment,openJiuwenEnvironment,projectRoot} from './lib/openjiuwen-environment.mjs';
import {exportLegacyAssetOrders} from './export-legacy-asset-orders.mjs';
import {codeRevision} from './lib/code-revision.mjs';

if(process.argv.includes('--judge-provider=codex_cli'))process.env.FINANCE_EVAL_JUDGE_PROVIDER='codex_cli';
const {python}=checkOpenJiuwenEnvironment();
const data=path.resolve(process.env.FINANCE_EVAL_DATA_DIR||path.join(projectRoot,'data'));
await exportLegacyAssetOrders(data,process.env.FINANCE_EVAL_WORKSPACE_SEED_DIRECTORY);
const child=spawn(python,['-B','-m','api'],{cwd:projectRoot,env:openJiuwenEnvironment({...process.env,
  FINANCE_EVAL_CODE_REVISION_JSON:JSON.stringify(codeRevision(projectRoot))}),
  windowsHide:true,stdio:['pipe','inherit','inherit']});
let stopping=false;
process.stdin.pipe(child.stdin);
function stop(){if(!stopping){stopping=true;child.stdin.end('stop\n');}}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
child.on('error',()=>{console.error('Python HTTP service could not start');process.exitCode=1;});
child.on('exit',code=>{process.stdin.unpipe(child.stdin);process.stdin.pause();process.exitCode=code??1;});
