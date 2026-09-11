import {mkdir,copyFile,writeFile,readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
const data=path.resolve(process.argv[2]??'.migration-native-host');
await mkdir(data,{recursive:true,mode:0o700});
for(const [source,target] of [['reference-ports.json','ports.json'],['reference-fixtures.json','fixtures.json']])await copyFile(path.resolve('examples/migration-native-host',source),path.join(data,target));
try{await readFile(path.join(data,'access-token'));}catch(e){if(e.code!=='ENOENT')throw e;await writeFile(path.join(data,'access-token'),randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});}
// Explicit synthetic-only test authority, not production identity or bank IAM.
try{await readFile(path.join(data,'grant.json'));}catch(e){if(e.code!=='ENOENT')throw e;await writeFile(path.join(data,'grant.json'),JSON.stringify({active:true,subject:'synthetic-reference-customer',scope:'reference:balance:read',expiresAt:new Date(Date.now()+30*86400000).toISOString()}),{mode:0o600,flag:'wx'});}
console.log('Initialized synthetic-only Host configuration; existing grant/token preserved.');
