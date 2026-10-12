import {LocalMigrationValidationRunner} from './migration-technical-validator.js';
import type {ContainerJob} from './container-migration-validator.js';

// Runs inside the immutable operator image, never in the API process.
// Also stop if the API dies and can no longer enforce its external deadline.
const deadline=setTimeout(()=>process.exit(124),Number(process.env.FINANCE_EVAL_CONTAINER_DEADLINE_MS)||480000);
let source='';
process.stdin.setEncoding('utf8');
for await(const chunk of process.stdin){source+=String(chunk);if(Buffer.byteLength(source)>16*1024*1024)throw new Error('Trial input limit');}
const job=JSON.parse(source) as ContainerJob;
const input={...job.input,archive:Object.fromEntries(Object.entries(job.input.archive).map(([name,value])=>[name,Buffer.from(value,'base64')]))};
const runner=new LocalMigrationValidationRunner();
const result=job.kind==='SCRIPT'?await runner.validateScript(input):job.kind==='MCP'?await runner.validateMcp(input):null;
if(!result)throw new Error('Unknown trial kind');
process.stdout.write(JSON.stringify(result));
clearTimeout(deadline);
