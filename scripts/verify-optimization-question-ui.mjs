import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {createServer} from 'vite';

// Browser and Vite only; every API response below is a controlled in-memory fixture.
const vite=await createServer({plugins:[{name:'optimization-question-harness',
  resolveId(id){if(id==='virtual:optimization-question-harness')return '\0virtual:optimization-question-harness';},
  load(id){if(id==='\0virtual:optimization-question-harness')return `import React from 'react';
    import {createRoot} from 'react-dom/client';import {OptimizationPanel} from '/src/OptimizationPanel.tsx';
    createRoot(document.getElementById('root')).render(React.createElement(OptimizationPanel,{job:{jobId:'source'}}));`;}}],
  server:{host:'127.0.0.1',port:0,strictPort:false,proxy:{}}});
let browser;
let item={optimizationId:'opt-aaaaaaaa',sourceJobId:'source',sourceAssetId:'asset',createdAt:'2026-01-01T00:00:00Z',
  updatedAt:'2026-01-01T00:00:00Z',status:'waiting',modelId:'fixture',summary:'等待回答',findings:[],changes:[],
  candidate:null,rerunJobId:null,error:null,stages:[],engineeringInteraction:{attemptId:'attempt-1',interactions:[{
    id:'question-1',value:{questions:[{question:'允许修改工具吗？',options:[{label:'允许',description:'修改随包工具'},{label:'不允许'}]},
      {question:'需要检查哪些方面？',multi_select:true,options:[{label:'输入'},{label:'输出'}]}]}}]}};
let submitted;
try{
  await vite.listen();
  const address=vite.httpServer.address();
  const base=`http://127.0.0.1:${address.port}`;
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',error=>{errors.push(error.message);console.error(error.message);});
  page.on('response',response=>{if(response.status()>=400){const error=`${response.status()} ${new URL(response.url()).pathname}`;errors.push(error);console.error(error);}});
  await page.route('**/__optimization_question_test',route=>route.fulfill({status:200,contentType:'text/html',body:`<!doctype html><div id="root"></div>
    <script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;
      window.__vite_plugin_react_preamble_installed__=true;
      await import('/@id/__x00__virtual:optimization-question-harness');
    </script>`}));
  await page.route('**/api/**',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.pathname.endsWith('/answer')){
      submitted=request.postDataJSON();item={...item,status:'review',summary:'复测与审查已完成',engineeringInteraction:undefined};
      return route.fulfill({status:202,json:item});
    }
    return route.fulfill({status:200,json:item});
  });
  await page.goto(base+'/__optimization_question_test');
  await expect(page.getByText('允许修改工具吗？'),JSON.stringify(errors)).toBeVisible();
  await page.reload();
  await expect(page.getByText('允许修改工具吗？')).toBeVisible();
  await page.getByRole('button',{name:'允许',exact:true}).click();
  await expect(page.getByLabel('你的回答').first()).toHaveValue('允许');
  await page.getByLabel('你的回答').first().fill('允许，保留原有业务规则');
  await page.getByRole('button',{name:'输入',exact:true}).click();
  await page.getByRole('button',{name:'输出',exact:true}).click();
  await expect(page.getByLabel('你的回答').nth(1)).toHaveValue('输入、输出');
  await page.getByRole('button',{name:'回答并继续优化'}).click();
  await expect(page.getByText('复测与审查已完成')).toBeVisible();
  assert.deepEqual(submitted,{interactionId:'question-1',answers:{'允许修改工具吗？':'允许，保留原有业务规则','需要检查哪些方面？':'输入、输出'}});
  assert.deepEqual(errors,[]);
  console.log('PASSED: question reload, option selection, free-form answer and submission');
}finally{
  await browser?.close();
  await vite.close();
}
