import {createServer} from 'vite';
import {chromium,expect} from '@playwright/test';
import {writeFile,mkdir,unlink,access} from 'node:fs/promises';
import assert from 'node:assert/strict';
const file='web/src/__activity-preview.tsx',html='web/__activity-preview.html';
for(const target of [file,html]){await access(target).then(()=>{throw new Error('Preview path already exists');},()=>{});}
await writeFile(file,"import React from 'react';import {createRoot} from 'react-dom/client';import {MigrationActivity} from './MigrationActivity';import './migration.css';import './styles.css';import './ea-theme.css';createRoot(document.getElementById('root')!).render(<main className='main-content'><section className='migration-panel'><MigrationActivity projectId='fixture'/></section></main>);");
await writeFile(html,'<html><body><div id="root" style="max-width:820px;margin:auto"></div><script type="module" src="/src/__activity-preview.tsx"></script></body></html>');
let server,browser;
try{
 server=await createServer({server:{port:0,host:'127.0.0.1'}});await server.listen();const address=server.httpServer.address();
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1000,height:850}});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>{
  const realFetch=window.fetch;window.fetch=async(input,init)=>{
   if(String(input).endsWith('/cancel')){window.cancelCalled=true;return new Response('{}',{status:window.cancelFails?500:200});}
   if(String(input).endsWith('/activity/events'))return new Response(new ReadableStream({start(controller){
    const now=Date.now();window.activity??={taskId:'fixture',status:'RUNNING',startedAt:new Date(now-120000).toISOString(),updatedAt:new Date(now).toISOString(),events:Array.from({length:40},(_,i)=>({id:i,at:new Date(now-1000*(40-i)).toISOString(),kind:'tool_end',label:'工具结束：read_file '+i}))};
    window.connections=(window.connections??0)+1;window.disconnectActivity=()=>controller.close();
    window.pushActivity=()=>controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify(window.activity)+'\n\n'));window.pushActivity();
   }}),{headers:{'content-type':'text/event-stream'}});
   return realFetch(input,init);
  };
 });
 await page.goto(`http://127.0.0.1:${address.port}/__activity-preview.html`);
 await page.getByRole('region',{name:'Agent 实时活动'}).waitFor();
 await expect(page.locator('.activity-heading')).toHaveCSS('display','block');
 await expect(page.locator('.agent-activity')).toHaveCSS('box-shadow','none');
 await expect(page.getByRole('button',{name:'取消任务'})).toHaveCSS('margin','0px');
 const area=page.getByLabel('活动记录');await page.waitForTimeout(250);
 assert(await area.evaluate(el=>el.scrollTop+el.clientHeight>=el.scrollHeight-36));
 await area.evaluate(el=>{el.scrollTop=0;el.dispatchEvent(new Event('scroll',{bubbles:true}));});
 await page.evaluate(()=>{window.activity.updatedAt=new Date().toISOString();window.activity.events.push({id:41,at:new Date().toISOString(),kind:'tool_start',label:'调用工具：compile_source'});window.pushActivity();});
 await page.getByRole('button',{name:'有新活动 · 回到最新'}).waitFor();assert.equal(await area.evaluate(el=>el.scrollTop),0);
 await page.getByRole('button',{name:'有新活动 · 回到最新'}).click();assert(await area.evaluate(el=>el.scrollTop+el.clientHeight>=el.scrollHeight-36));
 await page.evaluate(()=>window.cancelFails=true);
 await page.getByRole('button',{name:'取消任务'}).click();await expect(page.getByRole('alert')).toHaveText('取消请求未成功，请重试');
 await page.evaluate(()=>window.cancelFails=false);
 await page.getByRole('button',{name:'取消任务'}).click();assert(await page.evaluate(()=>window.cancelCalled));await expect(page.getByRole('alert')).toHaveCount(0);
 await page.evaluate(()=>{window.activity.updatedAt=new Date().toISOString();window.activity.events.push({id:42,at:new Date().toISOString(),kind:'text_snapshot',label:'接收模型响应',text:'{"status":"PRODUCED"}'});window.pushActivity();});
 await page.getByText('查看响应内容').focus();await page.keyboard.press('Enter');await expect(page.locator('details pre')).toBeVisible();
 await page.getByText('查看响应内容').evaluate(el=>el.blur());
 await area.evaluate(el=>{el.scrollTop=el.scrollHeight;el.dispatchEvent(new Event('scroll',{bubbles:true}));});
 await expect(page.locator('.activity-latest')).toHaveCount(0);
 await mkdir('artifacts/migration-activity',{recursive:true});await page.screenshot({path:'artifacts/migration-activity/activity-desktop.png'});
 await page.setViewportSize({width:390,height:820});await expect(area).toHaveCSS('height','300px');
 await area.evaluate(el=>el.scrollTop=el.scrollHeight);await page.screenshot({path:'artifacts/migration-activity/activity-mobile.png'});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
 await page.evaluate(()=>window.disconnectActivity());
 await expect(page.getByText('连接中断，正在重新连接…')).toBeVisible();await expect(page.getByText('正在运行',{exact:true})).toBeVisible();
 await expect.poll(()=>page.evaluate(()=>window.connections)).toBe(2);await expect(page.getByText('连接中断，正在重新连接…')).toHaveCount(0);
 for(const [status,label] of [['FAILED','执行失败'],['CANCELLED','已取消'],['INTERRUPTED','执行已中断'],['COMPLETED','执行结束']]){
  await page.evaluate(({status})=>{window.activity.status=status;window.activity.updatedAt=new Date().toISOString();window.pushActivity();},{status});
  await expect(page.locator('.agent-activity>header strong')).toHaveText(label);await expect(page.getByRole('button',{name:'取消任务'})).toHaveCount(0);
 }
 await page.reload();await page.getByRole('region',{name:'Agent 实时活动'}).waitFor();
 await page.evaluate(()=>{window.activity.events=[{id:0,at:new Date().toISOString(),kind:'tool_error',label:'工具失败：compile_source',text:'<script>window.injected=true</script>\n'+('very_long_tool_output_'.repeat(100))}];window.activity.updatedAt=new Date().toISOString();window.pushActivity();});
 await page.getByText('查看响应内容').click();await expect(page.locator('.activity-error pre')).toBeVisible();
 assert.equal(await page.evaluate(()=>window.injected),undefined);
 for(const width of [320,390,768,1280]){
  await page.setViewportSize({width,height:820});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),`Overflow at ${width}px`);
 }
 await page.emulateMedia({reducedMotion:'reduce'});await page.evaluate(()=>{window.activity.events.at(-1).kind='text_snapshot';window.activity.updatedAt=new Date().toISOString();window.pushActivity();});
 await expect(page.locator('.activity-spinner')).toHaveCSS('animation-name','none');
 assert.deepEqual(errors,[]);
 console.log('PASS: production theme, auto-follow, scroll retention, new activity badge, return to latest, cancellation success/failure, keyboard response expansion, reconnect, terminal states, error details, safe text rendering, 320/390/768/1280px widths, reduced motion, no browser errors');
}finally{await browser?.close();await server?.close();await unlink(file);await unlink(html);}
