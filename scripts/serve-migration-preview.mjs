import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createEvaluationService } from '../dist/service/server.js';

// Private single-user preview; no customer package is loaded automatically.
const data=path.resolve(process.env.MIGRATION_PREVIEW_DATA || '.migration-preview');
await mkdir(data,{recursive:true,mode:0o700});
const accessFile=path.join(data,'access-token');
let token;
try {token=(await readFile(accessFile,'utf8')).trim();}
catch(error){if(error.code!=='ENOENT')throw error;token=randomBytes(32).toString('hex');await writeFile(accessFile,token,{mode:0o600,flag:'wx'});}
const port=Number(process.env.MIGRATION_PREVIEW_PORT || 56401);
const app=await createEvaluationService({rootDirectory:process.cwd(),dataDirectory:data,publicDirectory:path.resolve('web-dist'),
  accessToken:token,publicDemo:false,host:'127.0.0.1',port});
await app.listen({host:'127.0.0.1',port});
console.log(`Private preview: http://127.0.0.1:${port}; access token file: ${accessFile}`);
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{void app.close().then(()=>process.exit(0));});
