import assert from 'node:assert/strict';
import {expect} from '@playwright/test';
import {verifiedDeliveryEvidence} from './migration-acceptance-results.mjs';

/** Continue the same adopted candidate through real reuse checks and verified download.
 * Mutations use visible UI controls; api is read-only evidence inspection. */
export async function verifyReuseDeliveryThroughUi({page,api,base,persistEvidence,downloadPath,timeout=1_800_000}) {
  const region=page.getByRole('region',{name:'复用验收'});
  const planned=page.waitForResponse(r=>r.url().endsWith('/reuse-acceptance/plan')&&r.request().method()==='POST',{timeout});
  void planned.catch(()=>{});
  await region.getByRole('button',{name:/^(生成|重新生成)验收计划$/}).click();
  const response=await planned;assert.equal(response.status(),200);
  const plan=await response.json();await persistEvidence?.({reusePlan:plan});
  assert.equal(plan.coverage.status,'COVERED',plan.coverage.reasons.join('; '));
  await region.getByRole('button',{name:'确认验收计划',exact:true}).click();
  await expect(region.getByRole('button',{name:'执行复用验收',exact:true})).toBeEnabled();
  const started=page.waitForResponse(r=>r.url().endsWith('/reuse-acceptance/start')&&r.request().method()==='POST');
  void started.catch(()=>{});await region.getByRole('button',{name:'执行复用验收',exact:true}).click();
  const startResponse=await started;assert.equal(startResponse.status(),200);const taskId=(await startResponse.json()).taskId;
  await expect.poll(async()=>{const s=await api('GET',base+'/reuse-acceptance');return s.result?.taskId===taskId?s.status:'RUNNING'},
    {timeout,intervals:[1000,3000]}).not.toBe('RUNNING');
  const reuse=await api('GET',base+'/reuse-acceptance');
  const jobs=await Promise.all(reuse.result.jobs.map(j=>api('GET',`/api/runs/${j.jobId}`)));
  await persistEvidence?.({reuse,jobs});assert.equal(reuse.status,'PASSED',reuse.result.reason);
  assert(jobs.length&&jobs.every(j=>j.status==='completed'&&j.finalization?.resources.status==='RELEASED'),
    'Reuse groups need completed execution and explicit resource release');
  await page.reload();await page.getByRole('button',{name:'Skill 迁移',exact:true}).click();await page.getByRole('button',{name:'旧版任务记录',exact:true}).click();
  const before=await api('GET',base+'/report');
  await page.locator('.migration-project').filter({has:page.getByText(before.project.name,{exact:true})}).getByRole('button',{name:'继续处理',exact:true}).click();
  await page.getByRole('navigation',{name:'迁移步骤'}).getByRole('button',{name:/下载/}).click();
  const download=page.waitForEvent('download');
  const exported=page.waitForResponse(r=>r.url().endsWith('/export')&&r.request().method()==='GET');
  void exported.catch(()=>{});await page.getByRole('button',{name:'下载迁移包',exact:true}).click();
  const downloaded=await download,exportResponse=await exported;
  assert.equal(exportResponse.status(),200);assert(!downloaded.suggestedFilename().endsWith('-unverified.zip'));
  const headers=exportResponse.headers();assert.equal(headers['x-migration-acceptance'],'VERIFIED');
  assert.equal(headers['x-migration-business-acceptance'],'PASSED');assert.equal(headers['x-migration-reuse-acceptance'],'PASSED');
  if(downloadPath)await downloaded.saveAs(downloadPath);
  const report=await api('GET',base+'/report'),task=report.project.improvementTasks.at(-1);
  const evidence=verifiedDeliveryEvidence({report,reuse,task,exportDigest:headers['x-migration-candidate-digest']});
  await persistEvidence?.({deliveryReport:report,deliveryEvidence:evidence});return evidence;
}
