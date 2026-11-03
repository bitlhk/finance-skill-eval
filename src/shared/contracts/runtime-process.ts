import {z} from 'zod';

/** Execution-side records returned through the existing execute response, not a telemetry transport. */
export const runtimeProcessSchema=z.strictObject({
  schemaVersion:z.literal('finance.runtime-process.v1'),
  status:z.enum(['COMPLETE','PARTIAL','UNAVAILABLE']),
  scopes:z.array(z.enum(['messages','models','tools','events'])).max(4),
  reason:z.string().min(1).max(2000).optional(),
  records:z.array(z.strictObject({
    id:z.string().min(1).max(200),
    kind:z.enum(['message','model','tool','event']),
    callId:z.string().min(1).max(200).optional(),
    name:z.string().min(1).max(200).optional(),
    role:z.enum(['user','assistant','system']).optional(),
    status:z.enum(['completed','failed','incomplete']).optional(),
    timestamp:z.string().datetime().optional(),
    durationMs:z.number().finite().nonnegative().optional(),
    input:z.unknown().optional(),output:z.unknown().optional(),
    error:z.string().max(4000).optional(),
    data:z.unknown().optional(),
  })).max(512),
}).superRefine((value,ctx)=>{
  const issue=(message:string)=>ctx.addIssue({code:'custom',message});
  if(new Set(value.scopes).size!==value.scopes.length)issue('Process scopes must be unique');
  if(new Set(value.records.map(r=>r.id)).size!==value.records.length)issue('Process record IDs must be unique');
  if(value.status!=='COMPLETE'&&!value.reason)issue('Partial or unavailable process requires a reason');
  if(value.status==='UNAVAILABLE'&&value.records.length)issue('Unavailable process cannot contain records');
  if(value.status==='COMPLETE'&&!value.scopes.length)issue('Complete process requires an explicit collection scope');
  const calls=new Set<string>();
  for(const record of value.records){
    const scope={message:'messages',model:'models',tool:'tools',event:'events'}[record.kind];
    if(!value.scopes.includes(scope as typeof value.scopes[number]))issue('Record is outside declared process scopes');
    if(record.kind==='tool'||record.kind==='model'){
      if(!record.callId||!record.name||!record.status)issue('Tool/model records require callId, name and status');
      const key=`${record.kind}:${record.callId}`;
      if(calls.has(key))issue('One terminal record per tool/model call is required');
      calls.add(key);
    }
    if(record.kind==='message'&&!record.role)issue('Message records require role');
    if(record.status==='incomplete'&&value.status==='COMPLETE')issue('Incomplete calls require partial process status');
  }
  try{if(Buffer.byteLength(JSON.stringify(value),'utf8')>131072)issue('Process evidence exceeds 131072 bytes');}
  catch{issue('Process evidence must be JSON serializable');}
});
export type RuntimeProcess=z.infer<typeof runtimeProcessSchema>;
