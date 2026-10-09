export type ReuseAcceptancePhase='PLAN'|'COVERAGE'|'PREPARATION'|'EXECUTION'|'VERIFICATION';
export type ReuseAcceptanceFailure={phase:ReuseAcceptancePhase;code:string;message:string;groupId?:string;caseId?:string;jobId?:string;fields?:string[]};
/** Only explicitly constructed public messages; never expose model/provider/SDK raw errors. */
export class ReuseAcceptanceError extends Error{
  readonly statusCode=409;
  constructor(readonly failure:ReuseAcceptanceFailure){
    const phases={PLAN:'生成验收计划',COVERAGE:'检查覆盖范围',PREPARATION:'准备运行',EXECUTION:'执行案例',VERIFICATION:'核对验收结果'};
    const issues:Record<string,string>={invalid_type:'类型不正确',too_small:'数量或长度不足',too_big:'超过数量或长度上限',unrecognized_keys:'包含未支持字段',invalid_enum_value:'字段值不受支持',invalid_string:'文本格式不正确'};
    const fields=failure.fields?.map(field=>field.replace(/ \((\w+)\)$/u,(_,code:string)=>`：${issues[code]??'字段不符合要求'}`));
    super(`${phases[failure.phase]}：${failure.message}${fields?.length?'（'+fields.join('；')+'）':''}`);this.name='ReuseAcceptanceError';
  }
}
