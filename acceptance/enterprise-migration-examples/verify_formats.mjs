import {readFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {manualPreparationSchema} from '../../src/service/contracts.ts';
import {runtimeToolConfigSchema} from '../../src/runtime-tool-config.ts';

const root=path.dirname(fileURLToPath(import.meta.url));
for(const name of (await readdir(root)).filter(name=>/^0[1-4]-/.test(name))){
  const read=async filename=>JSON.parse(await readFile(path.join(root,name,filename),'utf8'));
  manualPreparationSchema.parse(await read('suite.json'));
  if(!name.startsWith('01-'))runtimeToolConfigSchema.parse(await read('runtime-config.json'));
}
console.log('4 suites and 3 Runtime configurations match current platform schemas.');
