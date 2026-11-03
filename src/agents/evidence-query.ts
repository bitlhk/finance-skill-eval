import {z} from 'zod';
import {readEvidencePointer} from '../evaluation/domain/evidence-resources.js';
import {canonicalSha256} from '../shared/json-canonicalization.js';

export const evidenceQuerySchema=z.strictObject({path:z.string().max(500),operation:z.enum(['read','list']).default('read'),offset:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(12000).default(6000)});
export function queryEvidence(resources:unknown,request:z.input<typeof evidenceQuerySchema>){
  const query=evidenceQuerySchema.parse(request);
  const value=readEvidencePointer(resources,query.path);
  if(value===undefined)return {available:false,path:query.path};
  if(query.operation==='list'){
    const items=value!==null&&typeof value==='object'?Object.entries(value):[];
    const limit=Math.min(query.limit,64);
    return {available:true,path:query.path,entries:items.slice(query.offset,query.offset+limit).map(([key,item])=>({
      path:query.path+'/'+key.replace(/~/g,'~0').replace(/\//g,'~1'),
      label:item&&typeof item==='object'&&'path' in item?String(item.path):key,
      type:Array.isArray(item)?'array':typeof item,
    })),totalItems:items.length,nextOffset:query.offset+limit<items.length?query.offset+limit:null};
  }
  const text=JSON.stringify(value);
  return {available:true,path:query.path,digest:canonicalSha256(JSON.parse(text)),content:text.slice(query.offset,query.offset+query.limit),
    totalCharacters:text.length,nextOffset:query.offset+query.limit<text.length?query.offset+query.limit:null};
}
export function evidenceIndex(resources:unknown){
  if(!resources||typeof resources!=='object')return [];
  return Object.entries(resources).map(([key,value])=>({path:'/'+key.replace(/~/g,'~0').replace(/\//g,'~1'),
    type:Array.isArray(value)?'array':typeof value,items:Array.isArray(value)?value.length:undefined}));
}
