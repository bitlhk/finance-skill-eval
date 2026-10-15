import assert from 'node:assert/strict';
import {expect} from '@playwright/test';

/** Use the visible proposal and confirmation controls; no direct API bypass. */
export async function approveMigrationPlanThroughUi(page,onProposal){
  const response=page.waitForResponse(r=>r.url().endsWith('/plan/proposal')&&r.request().method()==='POST',{timeout:900000});
  void response.catch(()=>{});
  await page.getByRole('button',{name:/^(生成|更新)迁移方案$/}).click();
  const result=await response;
  assert(result.ok(),`Migration proposal failed: ${result.status()}`);
  const proposal=await result.json();
  await onProposal?.(proposal);
  assert(proposal.design?.scope&&proposal.design?.changes.length&&proposal.design?.acceptanceChecks.length,'Incomplete reusable migration design');
  assert.equal(proposal.design.unresolvedQuestions.length,0,`Migration design has unresolved material questions: ${proposal.design.unresolvedQuestions.join('; ')}`);
  await expect(page.getByRole('region',{name:'可复用迁移方案'})).toContainText(proposal.design.scope);
  await expect(page.getByRole('button',{name:'确认方案，进入生成',exact:true})).toBeEnabled();
  return proposal;
}
