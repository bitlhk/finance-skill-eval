/** Shared facts about the acceptance executor, not business migration strategies.
 * Planning and acceptance must not promise unsupported host-side operations. */
export const reuseExecutionContract={
  revision:'reuse-execution-v1',
  topology:{group:'fresh Runtime instances under the selected Launcher; not a new deployment',
    case:'independent native session, workspace and business-tool process',turns:'actual native calls preserving the same case session, workspace and tool lifecycle'},
  workspace:{initialFiles:'UTF-8 synthetic files mounted before execution',
    betweenTurns:'Eval has no file-write/delete, clock-control or service-restart operation between turns; only actually declared business/native tools can perform such actions'},
  evidence:{caseJudge:['current case queries, turn outputs and completed tool receipts','authorized redacted business projections and exact mounted-file/input matches'],
    checkJudge:['associated cases and their instance/session/workspace identity comparisons'],
    unavailable:['new Launcher deployment switching','host memory/model-context size measurements','implicit file mutations or external state changes']},
} as const;
