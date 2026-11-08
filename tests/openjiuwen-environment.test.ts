import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {openJiuwenEnvironment,projectPython,projectRoot,resolveOpenJiuwenPython,validateRuntimeConfiguration} from '../scripts/lib/openjiuwen-environment.mjs';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function workspace(){const root=mkdtempSync(path.join(os.tmpdir(),'finance-interpreter-'));roots.push(root);return root;}
function touch(file:string){mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,'fixture, never executed');}

it('selects the root environment on Windows and Linux without consulting PATH',()=>{
  const root=workspace();
  for(const platform of ['win32','linux']){
    const python=projectPython(root,platform);touch(python);
    expect(resolveOpenJiuwenPython({root,platform,env:{PATH:'old-system-python'}})).toBe(python);
  }
});
it('does not silently use a second environment when the canonical one is missing',()=>{
  const root=workspace();touch(path.join(root,'integrations/openjiuwen/.venv/bin/python'));
  expect(()=>resolveOpenJiuwenPython({root,env:{PATH:'system-python'}})).toThrow('No system Python fallback');
});
it('fails on a broken or relative operator override instead of falling back',()=>{
  const root=workspace();touch(projectPython(root));
  expect(()=>resolveOpenJiuwenPython({root,env:{FINANCE_EVAL_MIGRATION_PYTHON:'python'}})).toThrow('absolute');
  expect(()=>resolveOpenJiuwenPython({root,env:{FINANCE_EVAL_MIGRATION_PYTHON:path.join(root,'missing-python')}})).toThrow('missing');
});
it('isolates user site packages and inherited Python homes while preserving explicit fixture paths',()=>{
  const env=openJiuwenEnvironment({PYTHONHOME:'old-conda',PYTHONPATH:'owned-fixture',PYTHONNOUSERSITE:'0'});
  expect(env.PYTHONHOME).toBeUndefined();
  expect(env).toMatchObject({PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1'});
  expect(env.PYTHONPATH.split(path.delimiter)).toEqual([path.join(projectRoot,'src'),projectRoot,'owned-fixture']);
});

it('keeps startup model validation without revealing private configuration in errors',()=>{
  const file=path.join(workspace(),'runtime.json');
  for(const contents of ['PRIVATE_CONFIG_MARKER',JSON.stringify({models:{test:{apiKey:'PRIVATE_CONFIG_MARKER'}}})]){
    writeFileSync(file,contents);
    let error:unknown;try{validateRuntimeConfiguration(file);}catch(e){error=e;}
    expect(String(error)).toContain('configuration is missing or invalid');
    expect(String(error)).not.toContain('PRIVATE_CONFIG_MARKER');
  }
  writeFileSync(file,JSON.stringify({models:{test:{apiKey:'fixture',baseUrl:'http://unused',upstreamModelId:'model'}}}));
  expect(()=>validateRuntimeConfiguration(file)).not.toThrow();
});
