import {afterEach,expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createEvaluationService} from '../src/service/server.js';

const dirs:string[]=[];
afterEach(async()=>{await Promise.all(dirs.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});
it('requires both trusted ingress credential and the configured workspace subject on private reads and writes',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'workspace-ingress-'));dirs.push(dir);
  const app=await createEvaluationService({rootDirectory:path.resolve('.'),dataDirectory:dir,accessToken:'synthetic-ingress',workspaceSubject:'studio_admin',workspaceOrigin:'https://eval.example.test',publicDemo:false});
  const trusted={authorization:'Bearer synthetic-ingress','x-demo-user':'studio_admin'};
  try {
    expect((await app.inject({url:'/api/migrations',headers:{'x-demo-user':'studio_admin'}})).statusCode).toBe(401);
    expect((await app.inject({url:'/api/migrations',headers:{authorization:'Bearer synthetic-ingress'}})).statusCode).toBe(403);
    const otherAccount=await app.inject({url:'/api/migrations',headers:{...trusted,'x-demo-user':'studio_other'}});
    expect(otherAccount.statusCode).toBe(403);
    expect(otherAccount.json()).toEqual({error:'WORKSPACE_OWNER_REQUIRED',message:'当前登录账号无权访问此工作区，请使用自己的工作区。'});
    expect((await app.inject({url:'/api/migrations',headers:trusted})).statusCode).toBe(200);
    const payload={name:'runtime',type:'runtime_launcher',runtimeType:'agentscope',baseUrl:'http://127.0.0.1:1/'};
    expect((await app.inject({method:'POST',url:'/api/environments',headers:trusted,payload})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url:'/api/environments',headers:{...trusted,origin:'https://attacker.example'},payload})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url:'/api/environments',headers:{...trusted,origin:'https://eval.example.test'},payload})).statusCode).toBe(200);
    expect((await app.inject({url:'/api/health'})).statusCode).toBe(200);
  }finally{await app.close();}
});
it('cannot enable single-owner workspace with only a spoofable identity header',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'workspace-unsafe-'));dirs.push(dir);
  await expect(createEvaluationService({rootDirectory:path.resolve('.'),dataDirectory:dir,accessToken:null,workspaceSubject:'studio_admin',workspaceOrigin:'https://eval.example.test'})).rejects.toThrow('trusted ingress');
});
