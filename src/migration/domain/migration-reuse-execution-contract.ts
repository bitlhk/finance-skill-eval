/** Shared facts about the acceptance executor, not business migration strategies.
 * Planning and acceptance must not promise unsupported host-side operations. */
export const reuseExecutionContract={
  revision:'reuse-execution-v2',
  topology:{group:'fresh Runtime instances at the selected, frozen group.runtime target; default primary Launcher; distinct admitted deployment identities and endpoints required for cross-deployment acceptance',
    case:'independent native session and workspace; business-tool state follows its declared ownership and lifecycle, not a universal fresh OS process guarantee',turns:'actual native calls preserving the same case session, workspace and tool lifecycle'},
  workspace:{initialFiles:'UTF-8 synthetic files mounted before execution',
    betweenTurns:'Eval has no file-write/delete, clock-control or service-restart operation between turns; only actually declared business/native tools can perform such actions'},
  evidence:{caseJudge:['current case queries, turn outputs and completed tool receipts','authorized redacted business projections and exact mounted-file/input matches','toolResultInputMatches: full consumer argument digest equals schema-selected fields of an earlier authorized tool result; value equality and call order, not causal or internal-state proof'],
    checkJudge:['associated cases and their instance/session/workspace identity comparisons'],
    deployment:'group.runtime may select an availableRunTargets environment/model pair; additional targets must be operator-admitted Builder deliveries; alias registrations and new instances are not new deployments',
    unavailable:['unregistered or unadmitted deployment switching','host memory/model-context size measurements','implicit file mutations or external state changes']},
} as const;
