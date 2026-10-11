/** Operational metadata only: never prompts, source, credentials or raw provider errors. */
export type ReusePlannerTelemetry={
  traceId:string;mode:'PROPOSE'|'REVIEW';sourceDigest:string;candidateDigest?:string;startedAt:string;finishedAt?:string;elapsedMs:number;
  status:'RUNNING'|'COMPLETED'|'FAILED';inputCharacters:number;originalInputCharacters:number;
  failureCode?:'TIME_LIMIT'|'PLANNER_FAILED'|'MODEL_HTTP_ERROR'|'MODEL_OUTPUT_TRUNCATED'|'MODEL_EMPTY_RESPONSE'|'MODEL_NETWORK_ERROR';
  calls:Array<{requestId:string;startedAt:string;elapsedMs:number;inputCharacters:number;outputCharacters?:number;status:'RUNNING'|'COMPLETED'|'FAILED';
    modelId:string;retryReason?:'OUTPUT_FORMAT'|'SOURCE_EVIDENCE'|'DESIGN_CONTRACT';issueCount?:number;validationFields?:string[];
    usage?:{inputTokens?:number;outputTokens?:number;totalTokens?:number}}>;
};
