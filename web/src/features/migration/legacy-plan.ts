import type { BundleAnalysis } from "../../../../contracts/platform/responses";

/** Formatting only: keep original wording, and never infer missing business requirements. */
export function proseParagraphs(text: string, separators='。；'): string[] {
  const parts:string[]=[],stack:string[]=[];let start=0,code=false;
  const pairs:Record<string,string>={'（':'）','(' : ')','[':']','{':'}','「':'」','“':'”'};
  for(let i=0;i<text.length;i++) {
    const char=text[i]!;
    if(char==='`'){code=!code;continue;}if(code)continue;
    if(pairs[char])stack.push(pairs[char]!);else if(stack.at(-1)===char)stack.pop();
    if(!stack.length && (separators.includes(char)||char==='\n'&&text[i+1]==='\n')) {
      const part=text.slice(start,i+1).trim();if(part)parts.push(part);start=i+1;
    }
  }
  const tail=text.slice(start).trim();if(tail)parts.push(tail);return parts;
}

/** Existing prose is segmented verbatim; no new migration decisions are inferred. */
export function legacyChangeCards(analysis: BundleAnalysis) {
  if(analysis.plan) return analysis.plan.changes.map(change=>({title:change.title,paths:[...new Set(change.evidence.map(item=>item.path))],
    points:proseParagraphs(change.implementation,'。；，'),original:change.implementation,memberIds:change.memberIds}));
  return analysis.changes.map((change,index)=>{
    const heading=change.reason.match(/^([^：:\n`]{2,24})[：:]/u);
    const body=heading?change.reason.slice(heading[0].length):change.reason;
    return {title:heading?.[1]??`改造项 ${index+1}`,paths:change.paths,points:proseParagraphs(body,'。；，'),original:change.reason,memberIds:[]};
  });
}

export function legacyPlanSections(analysis: BundleAnalysis) {
  const sections={scope:[] as string[],preservedBehavior:[] as string[],changes:[] as string[],conditions:[] as string[],acceptance:[] as string[]};
  const kinds:Record<string,keyof typeof sections>={'复用范围':'scope','保留的业务行为':'preservedBehavior','业务契约已核实并全部保留':'preservedBehavior','具体改造':'changes','改造方案':'changes','运行条件与依赖':'conditions','运行条件':'conditions','依赖配置':'conditions','待实施阶段运行时确认':'conditions','验收方式':'acceptance'};
  const pattern=/(复用范围|保留的业务行为|业务契约已核实并全部保留|具体改造|改造方案|运行条件与依赖|运行条件|依赖配置|待实施阶段运行时确认|验收方式)(?:（[^）]*）)?[：:]/gu;
  let key:keyof typeof sections='scope',start=0;
  for(const match of analysis.summary.matchAll(pattern)) {
    if((analysis.summary.slice(0,match.index).match(/`/g)?.length??0)%2)continue;
    sections[key].push(...proseParagraphs(analysis.summary.slice(start,match.index)));
    key=kinds[match[1]!]!;start=match.index!+match[0].length;
  }
  sections[key].push(...proseParagraphs(analysis.summary.slice(start)));
  return sections;
}
