import YAML from 'yaml';

export class CaseToolOutsideDeclaration extends Error{}

/** Installation scope comes from explicit method metadata, not the selected test subset. */
export function skillRuntimeRequirements(instructions:string|undefined,caseTools:string[],auxiliaryTools:string[]=[]):string[]{
  const cases=[...new Set(caseTools)].sort();
  const match=instructions&&/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(instructions);
  if(!match)return cases; // Existing non-declarative adapters keep their previous contract.
  const document=YAML.parseDocument(match[1]!);
  if(document.errors.length)throw Error('Skill 工具声明无法解析');
  const metadata=document.toJS() as unknown;
  if(!metadata||typeof metadata!=='object'||Array.isArray(metadata))throw Error('Skill 元数据必须为对象');
  const record=metadata as Record<string,unknown>;
  if('allowed-tools' in record&&'allowedTools' in record)throw Error('Skill 工具声明重复');
  if(!('allowed-tools' in record)&&!('allowedTools' in record))return cases;
  const raw='allowed-tools' in record?record['allowed-tools']:record.allowedTools;
  const tools=Array.isArray(raw)?raw:typeof raw==='string'&&raw.trim()?raw.split(/[\s,]+/u).filter(Boolean):null;
  if(!tools||tools.length>64||tools.some(t=>typeof t!=='string'||!t.trim()||t!==t.trim()||t==='*')
      ||new Set(tools).size!==tools.length)throw Error('Skill 工具声明无效；无工具方法应明确声明 []');
  const names=tools as string[];
  const extras=cases.filter(name=>!names.includes(name));
  if(extras.some(name=>!auxiliaryTools.includes(name)))throw new CaseToolOutsideDeclaration('案例工具不在 Skill 声明的依赖中，请核对方法版本和案例');
  return [...new Set([...names,...extras])].sort();
}
