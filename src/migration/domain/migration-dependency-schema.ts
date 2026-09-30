/** Validate the supported JSON Schema subset used by migration dependency contracts. */
export function validateDependencyData(value:unknown,schema:Record<string,unknown>|null,at='数据',depth=0):string[] {
  if(!schema)return [];
  if(depth>32)return ['数据结构超过校验深度限制'];
  const errors:string[]=[];const type=schema.type;
  const matches=(t:unknown)=>t==='object'?value!==null&&typeof value==='object'&&!Array.isArray(value):t==='array'?Array.isArray(value):t==='integer'?typeof value==='number'&&Number.isInteger(value):t==='null'?value===null:t==='number'?typeof value==='number':t==='string'?typeof value==='string':t==='boolean'?typeof value==='boolean':false;
  if(type!==undefined&&!(Array.isArray(type)?type.some(matches):matches(type)))return [`${at} 应为 ${Array.isArray(type)?type.join(' / '):String(type)}`];
  if(Array.isArray(schema.enum)&&!schema.enum.some(x=>JSON.stringify(x)===JSON.stringify(value)))errors.push(`${at} 不在允许值中`);
  if(value!==null&&typeof value==='object'&&!Array.isArray(value)){
    const obj=value as Record<string,unknown>,props=(schema.properties??{}) as Record<string,Record<string,unknown>>;
    if(typeof props!=='object'||Array.isArray(props))return ['依赖类型定义无效，请补充契约说明后继续分析'];
    for(const key of (Array.isArray(schema.required)?schema.required:[]))if(typeof key==='string'&&!(key in obj))errors.push(`${at} 缺少 ${key}`);
    for(const [key,v] of Object.entries(obj)){if(Object.prototype.hasOwnProperty.call(props,key)&&props[key])errors.push(...validateDependencyData(v,props[key],`${at}.${key}`,depth+1));else if(schema.additionalProperties===false)errors.push(`${at} 不允许字段 ${key}`)}
  }
  if(Array.isArray(value)&&schema.items&&typeof schema.items==='object')value.forEach((v,i)=>errors.push(...validateDependencyData(v,schema.items as Record<string,unknown>,`${at}[${i}]`,depth+1)));
  return errors;
}
