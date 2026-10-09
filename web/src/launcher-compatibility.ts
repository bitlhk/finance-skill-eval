import type {RuntimeLauncherCapabilities} from '../../src/shared/contracts/runtime-launcher';

export function launcherCompatibility(capabilities:RuntimeLauncherCapabilities|undefined,requiredTools:string[]):string[]{
  if(!capabilities)return ['环境尚未返回能力声明'];
  const names=[...new Set(requiredTools)],issues:string[]=[];
  if(capabilities.nativeToolNames){
    const missing=names.filter(n=>!capabilities.nativeToolNames!.includes(n));
    if(missing.length&&!capabilities.features.externalMcp)issues.push(`缺少已准入工具：${missing.join('、')}`);
  }
  const primary=names.filter(n=>!capabilities.auxiliaryToolNames?.includes(n));
  if(primary.length<(capabilities.limits.minPrimaryTools??0))issues.push('此环境要求装配业务能力包，暂不支持纯文本 Skill');
  return issues;
}
