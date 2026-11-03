import { afterEach, expect, it, vi } from 'vitest';
import type { ModelAdapter, ModelCompletionRequest } from '../src/adapters.js';
import { agentRoleIds, loadAgentRole } from '../src/agents/composition.js';
import { createEffectReviewer, createSkillEditor } from '../src/agents/tool-free-roles.js';
import { createImprovementDiagnoser } from '../src/agents/improvement-diagnoser.js';
import type { AgentCompositionReceipt } from '../src/shared/contracts/agent-composition.js';

afterEach(() => vi.useRealTimers());
const model = { providerId: 'fixture', modelId: 'model', parameters: {} };
const input = { files: { 'SKILL.md': 'Original instructions' }, developmentEvidence: [{ task: 'Task', answer: 'Answer' }] };
const proposal = { summary: 'Clarify missing information', findings: ['Evidence gap'], changes: [{ path: 'SKILL.md', content: 'Ask for missing facts.', reason: 'Avoid inventing facts' }] };
const reviewInput = { goal: 'Improve missing-data handling', baselineDigest: 'base', candidateDigest: 'candidate', changes: [{ path: 'SKILL.md', reason: 'Clarification' }],
  evidence: [{ evidenceId: 'case-1', evaluationDigest: 'evaluation-1', completed: true, comparable: true, summary: 'Candidate asks for missing data' }] };
function dependency(output: unknown) {
  const complete = vi.fn(async (_: ModelCompletionRequest) => ({ content: JSON.stringify(output), modelId: model.modelId }));
  return { complete, adapter: { adapterId: 'fixture', complete } satisfies ModelAdapter, model };
}

it.each([null,[],{}])('keeps a tool diagnosis when the model supplies an empty Builder field: %j',async requiredCapabilities=>{
  const hypothesis={layer:'TOOL',issue:'Equal limit incorrectly rejected',expectedBehavior:'Allow equal limit',
    evidenceCaseIds:['boundary'],validation:'Run the boundary case',risk:'Retest above-limit behavior',
    confidence:'HIGH',requiredCapabilities};
  const d=dependency({status:'PROPOSED',hypothesis});
  const diagnose=createImprovementDiagnoser({...d,capabilityFormat:{}});
  const result=await diagnose({modelId:'model',sourceJobId:'run',baseSolutionRevisionId:'candidate',
    tools:[],runtimeConfiguration:[],technicalEvidence:[],cases:[]},{requestId:'diagnosis'});
  expect(result.judgement).toMatchObject({status:'PROPOSED',hypothesis:{layer:'TOOL',evidenceCaseIds:['boundary']}});
  expect(result.judgement).not.toHaveProperty('hypothesis.requiredCapabilities');
  expect(d.complete).toHaveBeenCalledTimes(1);
});

it('loads every installed role without granting read-only roles write or execution tools', () => {
  for (const id of agentRoleIds) {
    const role = loadAgentRole(id);
    expect(role.resources.length).toBeGreaterThan(1);
    expect(role.systemPrompt).not.toMatch(/(?:^|\n\n)undefined(?:\n\n|$)/u);
    if (!['migration','runtime-preparation'].includes(id)) expect(role.definition.tools).not.toEqual(expect.arrayContaining(['write_file']));
    expect(role.definition.tools).not.toContain('bash');
  }
  expect(() => loadAgentRole('diagnosis', '../v1')).toThrow();
  expect(() => loadAgentRole('diagnosis', 'v999')).toThrow();
});

it('executes the editor without tools and saves composition without task content or model secrets', async () => {
  const d = dependency(proposal), receipts: AgentCompositionReceipt[] = [];
  const result = await createSkillEditor(d)({ ...input, constraints: 'INPUT_SECRET_MARKER' }, { requestId: 'edit', onComposition: r => { receipts.push(r); } });
  expect(result).toEqual({ status: 'PRODUCED', proposal });
  expect(d.complete).toHaveBeenCalledTimes(1);
  expect(d.complete.mock.calls[0]![0].toolFree).toBe(true);
  expect(receipts[0]).toMatchObject({ role: 'adjustment', version: 'v1', tools: [], budget: { kind: 'singleCompletion' } });
  expect(JSON.stringify(receipts)).not.toContain('INPUT_SECRET_MARKER');
  expect(JSON.stringify(receipts)).not.toContain(input.files['SKILL.md']);
});

it.each(['tool.py', '../SKILL.md', 'references/../../tool.md', 'references/link.py'])('rejects editor changes outside document scope: %s', async path => {
  const d = dependency({ ...proposal, changes: [{ ...proposal.changes[0], path }] });
  await expect(createSkillEditor(d)(input, { requestId: 'edit' })).rejects.toThrow();
});

it('rejects malformed output and returns real abstention without a retry', async () => {
  const d = dependency({ status: 'ABSTAINED', reason: 'No attributable defect' });
  expect(await createSkillEditor(d)(input, { requestId: 'edit' })).toEqual({ status: 'ABSTAINED', reason: 'No attributable defect' });
  d.complete.mockResolvedValueOnce({ content: 'not-json', modelId: 'model' });
  await expect(createSkillEditor(d)(input, { requestId: 'bad' })).rejects.toThrow();
  expect(d.complete).toHaveBeenCalledTimes(2);
});

it('preserves the existing six-document candidate capacity',async()=>{
  const changes=Array.from({length:6},(_,i)=>({path:`references/doc${i}.md`,content:'Updated guidance',reason:'Observed gap'}));
  const d=dependency({...proposal,changes});
  expect(await createSkillEditor(d)(input,{requestId:'six-documents'})).toMatchObject({status:'PRODUCED',proposal:{changes}});
});

it('does not send additional fields such as holdout reports into the editor', async () => {
  const d = dependency(proposal);
  await expect(createSkillEditor(d)({ ...input, holdout: 'secret' } as typeof input, { requestId: 'edit' })).rejects.toThrow();
  expect(d.complete).not.toHaveBeenCalled();
});

it.each(['cancel', 'timeout'] as const)('stops a pending role on %s even if the adapter ignores its signal', async kind => {
  vi.useFakeTimers();
  const d = dependency(proposal);
  let started!:()=>void;
  const modelStarted=new Promise<void>(resolve=>{started=resolve;});
  d.complete.mockImplementation(() => {started();return new Promise(() => {});});
  const controller = new AbortController();
  const promise = createSkillEditor(d)(input, { requestId: 'edit', signal: controller.signal, timeoutMs: 30 });
  const rejected = expect(promise).rejects.toThrow();
  await modelStarted;
  if (kind === 'cancel') controller.abort();
  else await vi.advanceTimersByTimeAsync(31);
  await rejected;
  expect(d.complete).toHaveBeenCalledTimes(1);
  expect(d.complete.mock.calls[0]![0].signal?.aborted).toBe(true);
});

it('does not start the model after cancellation', async () => {
  const d = dependency(proposal);
  await expect(createSkillEditor(d)(input, { requestId: 'edit', signal: AbortSignal.abort() })).rejects.toThrow();
  expect(d.complete).not.toHaveBeenCalled();
});

it('reviews a candidate independently and rejects invented evidence references', async () => {
  const output = { status: 'PRODUCED', review: { recommendation: 'KEEP_CANDIDATE', reason: 'Observed improvement', improvements: ['Asks for facts'], regressions: [], evidenceIds: ['case-1'] } };
  const d = dependency(output);
  expect(await createEffectReviewer(d)(reviewInput, { requestId: 'review' })).toEqual(output);
  const call = d.complete.mock.calls[0]![0];
  expect(call.toolFree).toBe(true);
  expect(call.messages[0]!.content).toContain('不执行采纳');
  d.complete.mockResolvedValueOnce({ content: JSON.stringify({ ...output, review: { ...output.review, evidenceIds: ['invented'] } }), modelId: 'model' });
  await expect(createEffectReviewer(d)(reviewInput, { requestId: 'bad-review' })).rejects.toThrow('unknown');
});

it('abstains before model execution when candidate evidence is incomplete or incomparable', async () => {
  const d = dependency({});
  for (const override of [{ completed: false }, { comparable: false }]) {
    expect(await createEffectReviewer(d)({ ...reviewInput, evidence: [{ ...reviewInput.evidence[0]!, ...override }] }, { requestId: 'review' }))
      .toMatchObject({ status: 'ABSTAINED' });
  }
  expect(d.complete).not.toHaveBeenCalled();
});

it('supports independent goal-based continuation with incumbent evidence and repair directions',async()=>{
  const output={status:'PRODUCED',review:{recommendation:'CONTINUE_CANDIDATE',reason:'Promising but needs repair',
    improvements:['Core workflow improved'],regressions:['Edge case regressed'],evidenceIds:['case-1'],
    tradeoff:'Preserve core improvements while repairing the edge case',nextFocus:['Repair the edge case']}};
  const d=dependency(output),input={...reviewInput,incumbentDigest:'best',protectedCaseIds:[],targetPassRate:.9,remainingRounds:2,
    evidence:reviewInput.evidence.map(e=>({...e,incumbent:{passed:true}}))};
  expect(await createEffectReviewer(d)(input,{requestId:'review'})).toEqual(output);
  const call=d.complete.mock.calls[0]![0];
  expect(JSON.parse(call.messages[1]!.content)).toMatchObject({incumbentDigest:'best',remainingRounds:2});
  expect(call.messages[0]!.content).toContain('普通案例回退不是自动否决条件');
});
