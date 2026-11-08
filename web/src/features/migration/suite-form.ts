/** Only remove case annotations, leaving all execution and evaluation inputs intact. */
export function suiteExecutionValue<T>(suite:T):T {
  if(!suite||typeof suite!=='object'||Array.isArray(suite))return suite;
  const value=suite as Record<string,unknown>;
  const cases=(items:unknown)=>Array.isArray(items)?items.map(item=>{
    if(!item||typeof item!=='object'||Array.isArray(item))return item;
    const {rationale: _rationale,...rest}=item as Record<string,unknown>;
    return rest;
  }):items;
  return {...value,...('cases' in value?{cases:cases(value.cases)}:{}),
    ...('holdoutCases' in value?{holdoutCases:cases(value.holdoutCases)}:{})} as T;
}
