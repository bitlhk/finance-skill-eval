import {it,expect} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MigrationReusePlan} from '../web/src/MigrationReusePlan';
import {CandidateStep} from '../web/src/MigrationPanel';
import type {MigrationReuseProposal,ReuseDesign} from '../src/migration/domain/migration-reuse-design.js';

const design:ReuseDesign={scope:'在声明依赖的 Runtime 上复用',preservedBehavior:['金额和规则保持'],sourceCouplings:[],
  changes:[{id:'portable',title:'显式交付工具',implementation:'保留业务逻辑',toolNames:[],evidence:[{path:'SKILL.md',snippet:'业务流程'}]}],
  dependencies:[],conditions:['提供工作区'],unresolvedQuestions:[],
  acceptanceChecks:[{id:'isolation',purpose:'请求不串扰',requirement:'不同业务请求不得读取对方的数据',procedure:'执行不同请求',expectedResult:'各自得到正确结果'}]};
const proposal:MigrationReuseProposal={proposalId:'new',inputDigest:'digest',sourceDigest:'source',createdAt:'now',design};
it('offers explicit clarification rather than letting unresolved proposals bypass confirmation',()=>{
 const html=renderToStaticMarkup(createElement(MigrationReusePlan,{proposal:{...proposal,clarification:'本次仅限任务范围',
  design:{...design,unresolvedQuestions:['部署范围待确认']}},clarify:()=>{}}));
 expect(html).toContain('方案补充说明');expect(html).toContain('补充说明并重新规划');
 expect(html).toContain('部署范围待确认');expect(html).toContain('本次仅限任务范围');
 expect(html).toContain('重新规划后仍需核对并确认方案');
});
it('does not present historical candidate passes as readiness for a revised plan',()=>{
  const html=renderToStaticMarkup(createElement(CandidateStep,{project:{candidate:{displayName:'旧产物',version:'1'},inspection:{reuseConformance:{proposalId:'old'}},portableGenerations:[]},
    report:{workflow:{stage:'GENERATE'},migrationPlan:{reuseProposal:proposal,generationAllowed:true,items:[],skillBlockingReasons:[]},technicalValidations:[]},
    assets:[],busy:false,generating:false} as any));
  expect(html).toContain('等待新方案实施');expect(html).toContain('按新方案生成');
  expect(html).not.toContain('候选包已准备好');expect(html).not.toContain('Runtime 适配与登记');expect(html).not.toContain('试运行通过');
});

it('shows each acceptance goal and a human-readable explicit revision comparison',()=>{
  const previousDesign={...design,scope:'不依赖任何宿主能力',conditions:['每次必须独立进程']};
  const html=renderToStaticMarkup(createElement(MigrationReusePlan,{proposal:{...proposal,previousProposalId:'old',previousDesign}}));
  expect(html).toContain('验证目标：');expect(html).toContain('不同业务请求不得读取对方的数据');
  expect(html).toContain('已调整：复用范围、运行条件');expect(html).toContain('请核对后重新确认');
  expect(html).toContain('每次必须独立进程');expect(html).toContain('在声明依赖的 Runtime 上复用');
  expect(html).toContain('不作为本版通过证据');expect(html).not.toContain('previousProposalId');
});

it('keeps old plans readable without inventing requirement explanations or revision history',()=>{
  const legacy=structuredClone(proposal);delete legacy.design.acceptanceChecks[0]!.requirement;
  const html=renderToStaticMarkup(createElement(MigrationReusePlan,{proposal:legacy}));
  expect(html).not.toContain('验证目标：');expect(html).not.toContain('本次方案更新');expect(html).toContain('请求不串扰');
});

it('does not label a confirmed revision as awaiting confirmation',()=>{
  const html=renderToStaticMarkup(createElement(MigrationReusePlan,{proposal:{...proposal,approvedAt:'now',previousProposalId:'old',previousDesign:design}}));
  expect(html).toContain('方案内容未变化');expect(html).toContain('本版已确认');expect(html).not.toContain('请核对后重新确认');
});
