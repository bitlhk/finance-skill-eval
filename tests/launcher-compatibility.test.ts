import {expect,it} from 'vitest';
import {launcherCompatibility} from '../web/src/launcher-compatibility.js';
import type {RuntimeLauncherCapabilities} from '../src/shared/contracts/runtime-launcher.js';
const caps={nativeToolNames:['query','read'],auxiliaryToolNames:['read'],features:{externalMcp:false},limits:{minPrimaryTools:1}} as RuntimeLauncherCapabilities;
it('reports missing native dependencies without substituting available tools',()=>{
  expect(launcherCompatibility(caps,['query'])).toEqual([]);
  expect(launcherCompatibility(caps,['wind'])).toEqual(['缺少已准入工具：wind']);
});
it('distinguishes auxiliary case files from required primary packages',()=>{
  expect(launcherCompatibility(caps,['read'])).toEqual(['此环境要求装配业务能力包，暂不支持纯文本 Skill']);
  expect(launcherCompatibility(caps,[])).toHaveLength(1);
  expect(launcherCompatibility(caps,['query','read'])).toEqual([]);
});
