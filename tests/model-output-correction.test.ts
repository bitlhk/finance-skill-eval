import {expect,it,vi} from 'vitest';
import {z} from 'zod';
import {OpenAiCompatibleModelAdapter} from '../src/openai-compatible-model.js';
import {CodexCliModelAdapter} from '../src/codex-cli-model.js';
import {correctModelOutput} from '../src/migration/infrastructure/model-output-correction.js';

const model={providerId:'test',modelId:'test-model',label:'test',parameters:{}};
const schema=z.object({status:z.enum(['PRODUCED','ABSTAINED']),value:z.string().optional()});
const check=(value:unknown)=>{
  const result=schema.safeParse(value);
  return result.success?{ok:true as const,value:result.data}:
    {ok:false as const,errors:result.error.issues.map(issue=>`${issue.path.join('.')}: ${issue.message}`)};
};
const adapter=()=>new OpenAiCompatibleModelAdapter({apiKey:'test',baseUrl:'http://127.0.0.1:1'});

it('extracts a fenced JSON object without calling the model again',async()=>{
  const remote=adapter(),complete=vi.spyOn(remote,'complete');
  const result=await correctModelOutput({raw:'说明\n```json\n{"status":"PRODUCED","value":"ok"}\n```',
    check,adapter:remote,model,requestId:'test'});
  expect(result).toMatchObject({ok:true,value:{status:'PRODUCED',value:'ok'},repairs:0});
  expect(complete).not.toHaveBeenCalled();
});

it('sends only the malformed answer and structured errors to a tool-free completion',async()=>{
  const remote=adapter(),complete=vi.spyOn(remote,'complete').mockResolvedValue({content:'{"status":"PRODUCED","value":"ok"}',modelId:'test-model'});
  const result=await correctModelOutput({raw:'{"status":"PRODUCED","value":',check,adapter:remote,model,requestId:'test'});
  expect(result).toMatchObject({ok:true,repairs:1});
  expect(complete).toHaveBeenCalledTimes(1);
  const request=complete.mock.calls[0]![0];
  expect(request.messages[1]?.content).toContain('validationErrors');
  expect(request.responseFormat).toBe('json');
});

it('rejects a repair that changes a parseable substantive claim',async()=>{
  const remote=adapter();vi.spyOn(remote,'complete').mockResolvedValue({content:'{"status":"PRODUCED","value":"changed"}',modelId:'test-model'});
  const result=await correctModelOutput({raw:'{"status":"PRODUCED","value":3}',check,adapter:remote,model,requestId:'test',
    preserve:(original,repaired)=>(original as {value:unknown}).value===(repaired as {value:unknown}).value});
  expect(result).toMatchObject({ok:false,repairs:1,error:'纠错结果改变了原始判断或证据'});
});

it('does not use a workspace-capable CLI adapter for format repair',async()=>{
  const remote=new CodexCliModelAdapter(),complete=vi.spyOn(remote,'complete');
  const result=await correctModelOutput({raw:'{"status":"PRODUCED","value":',check,adapter:remote,model,requestId:'test'});
  expect(result).toMatchObject({ok:false,repairs:0});
  expect(complete).not.toHaveBeenCalled();
});
