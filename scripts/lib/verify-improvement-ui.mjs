import assert from 'node:assert/strict';
import {expect} from '@playwright/test';

// Shared real-UI path; no backend mutation or substituted model decisions.
// api() is read-only here and exists to assert the persisted evidence behind the page.
export async function verifyImprovementThroughUi({page,api,base,suite,environmentId,verifyExternalEvidence,persistEvidence,timeout=1_800_000}){
  await page.getByRole('button',{name:/提供测试集和目标/}).click();
  await page.getByLabel('准备方式').selectOption('import');
  await page.getByLabel('预览或编辑测试集').fill(JSON.stringify(suite));
  const imported=page.waitForResponse(r=>r.url().endsWith('/suites/import')&&r.request().method()==='POST',{timeout:30_000});void imported.catch(()=>{});
  await page.getByRole('button',{name:'确认并导入',exact:true}).click();assert.equal((await imported).status(),200);
  if(environmentId)await page.locator('.assessment-config-grid select').nth(1).selectOption(environmentId);
  const baselineStarted=page.waitForResponse(r=>r.url().endsWith('/validate/openjiuwen')&&r.request().method()==='POST',{timeout:300_000});void baselineStarted.catch(()=>{});
  await page.getByRole('button',{name:'执行并自动评估',exact:true}).click();
  const baselineResponse=await baselineStarted;assert.equal(baselineResponse.status(),200);
  const baselineId=(await baselineResponse.json()).job.jobId;
  await expect.poll(async()=> (await api('GET',`/api/runs/${baselineId}`)).status,{timeout,intervals:[1000,3000]}).toMatch(/^(completed|failed|cancelled|interrupted)$/u);
  const baseline=await api('GET',`/api/runs/${baselineId}`);
  assert.equal(baseline.status,'completed','Baseline execution did not complete');
  assert.deepEqual(baseline.report.cases.map(c=>c.caseId).sort(),suite.cases.map(c=>c.id).sort());
  assert(baseline.report.cases.every(c=>!c.judgeError),'Judge failure is not candidate failure');
  const project=(await api('GET',base+'/report')).project,original=project.candidate;
  const workbench=page.getByRole('region',{name:'持续改进任务'});
  const started=page.waitForResponse(r=>r.url().endsWith('/improvement-tasks')&&r.request().method()==='POST',{timeout:30_000});void started.catch(()=>{});
  await expect(workbench.getByRole('button',{name:'开始持续改进',exact:true})).toBeEnabled({timeout:30_000});
  await workbench.getByRole('button',{name:'开始持续改进',exact:true}).click();assert.equal((await started).status(),200);
  await expect.poll(async()=> (await api('GET',base+'/improvement-tasks')).at(-1)?.status,{timeout,intervals:[1000,3000]}).not.toBe('RUNNING');
  const task=(await api('GET',base+'/improvement-tasks')).at(-1);
  assert.equal(task.status,'REVIEW',task.reason);assert(task.finalVerified&&task.finalConsumed);
  assert.equal((await api('GET',base+'/report')).project.candidate.artifactSha256,original.artifactSha256);
  if(baseline.report.cases.every(c=>c.judge?.goalAssessment?.verdict==='PASS')){
    assert.equal(task.iterations.length,0,'A passing baseline must not be rewritten');
    assert.equal(task.bestCandidate.artifactSha256,original.artifactSha256);
  }
  const final=await api('GET',`/api/runs/${task.finalJobId}`);
  await persistEvidence?.({baseline,task,final});
  assert.deepEqual(final.report.cases.map(c=>c.caseId).sort(),[...suite.cases,...suite.holdoutCases].map(c=>c.id).sort());
  assert(final.report.cases.every(c=>c.right.status==='completed' && !c.judgeError && c.judge?.goalAssessment?.verdict==='PASS'));
  const externalChecks=verifyExternalEvidence?await verifyExternalEvidence():[];
  await expect(workbench.getByRole('button',{name:'采用已通过复核的候选',exact:true})).toBeVisible({timeout:30_000});
  await workbench.getByRole('button',{name:'采用已通过复核的候选',exact:true}).click();
  await expect(workbench.getByText('已采用',{exact:true}).first()).toBeVisible({timeout:30_000});
  assert.equal((await api('GET',base+'/improvement-tasks')).at(-1).status,'ADOPTED');
  await persistEvidence?.({adoptedReport:await api('GET',base+'/report')});
  // Refresh exercises persisted task rendering rather than only component state.
  await page.reload();await page.getByRole('button',{name:'Skill 迁移',exact:true}).click();
  await page.locator('.migration-project').filter({has:page.getByText(project.name,{exact:true})}).getByRole('button',{name:'继续处理',exact:true}).click();
  await page.getByRole('navigation',{name:'迁移步骤'}).getByRole('button',{name:/验证实际效果/}).click();
  await expect(page.getByText('已采用',{exact:true}).first()).toBeVisible({timeout:30_000});
  return {taskId:task.taskId,baselineJobId:baselineId,finalJobId:task.finalJobId,externalChecks,
    iterations:task.iterations.map(({layer,outcome})=>({layer,outcome})),
    cases:final.report.cases.map(c=>({caseId:c.caseId,verdict:c.judge.goalAssessment.verdict}))};
}
