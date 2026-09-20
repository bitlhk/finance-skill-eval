import path from 'node:path';
import {unzipSync} from 'fflate';
import {fingerprint} from '../contracts.js';
import {readJson,writeJsonAtomic} from './file-store.js';
import type {Supplement} from './migration-dependencies.js';

function safeName(name:string){const p=name.replaceAll('\\','/');if(!p||p.startsWith('/')||/[:\x00]/u.test(p)||p.split('/').some(s=>s==='..'||s==='.'||!s))throw Object.assign(new Error('文件路径不安全'),{statusCode:400});return p}
export function supplementFiles(dependencyId:string,filename:string,bytes:Buffer):Record<string,string>{
 if(!bytes.length||bytes.length>8*1024*1024)throw Object.assign(new Error('补充文件大小须在 1 字节至 8 MB 之间'),{statusCode:400});
 const prefix=`.diagnosis-supplements/${dependencyId}/`;safeName(filename);
 if(filename.toLowerCase().endsWith('.zip')){
  // Reject symlinks in the ZIP central directory before extraction.
  for(let offset=0;offset+46<=bytes.length;offset++)if(bytes.readUInt32LE(offset)===0x02014b50){const mode=bytes.readUInt32LE(offset+38)>>>16;if((mode&0xf000)===0xa000)throw Object.assign(new Error('SDK ZIP 不允许符号链接'),{statusCode:400});offset+=45+bytes.readUInt16LE(offset+28)+bytes.readUInt16LE(offset+30)+bytes.readUInt16LE(offset+32)}
  let size=0;const seen=new Set<string>();const archive=unzipSync(bytes,{filter:file=>{if(file.name.endsWith('/'))return false;const p=safeName(file.name);if(seen.has(p))throw Object.assign(new Error('SDK ZIP 包含重复路径'),{statusCode:400});seen.add(p);size+=file.originalSize;if(size>16*1024*1024||seen.size>200)throw Object.assign(new Error('SDK ZIP 超过解压限制'),{statusCode:400});return true}});
  if(!Object.keys(archive).length)throw Object.assign(new Error('SDK ZIP 不能为空'),{statusCode:400});return Object.fromEntries(Object.entries(archive).map(([p,b])=>[prefix+safeName(p),Buffer.from(b).toString('base64')]));
 }
 return {[prefix+filename]:bytes.toString('base64')};
}
export class MigrationSupplements{
 constructor(private root:string){}
 private file(id:string){if(!/^migration-[a-f0-9-]+$/u.test(id))throw new Error('迁移项目不合法');return path.join(this.root,'migration-supplements',id+'.json')}
 async get(id:string):Promise<{revision:number;items:Supplement[]}>{try{return await readJson(this.file(id))}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {revision:0,items:[]};throw e}}
 async save(id:string,item:Supplement){const record=await this.get(id);record.revision++;record.items=[...record.items.filter(s=>s.dependencyId!==item.dependencyId),item];const entries=record.items.flatMap(s=>Object.entries(s.files??{}));if(entries.length>400||entries.reduce((n,[,b])=>n+Buffer.byteLength(b,'base64'),0)>32*1024*1024)throw Object.assign(new Error('项目补充材料超过 400 个文件或 32 MB'),{statusCode:400});await writeJsonAtomic(path.join(this.root,'migration-supplements','history',id,record.revision+'.json'),record);await writeJsonAtomic(this.file(id),record);return record}
 digest(record:{revision:number;items:Supplement[]}){return fingerprint(record)}
}
