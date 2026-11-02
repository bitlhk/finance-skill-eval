import {readFileSync} from 'node:fs';
import {configuredModelRole} from './config.js';
import {createImprovementDiagnoser} from '../agents/improvement-diagnoser.js';
import {createEffectReviewer} from '../agents/tool-free-roles.js';
import type {ImprovementAgents} from '../improvement/application/improvement-agents.js';

/** Freeze separate model sessions/configuration for one loop; never share editor conversation history with Review. */
export function configuredImprovementAgents():ImprovementAgents{
  const optimizer=configuredModelRole('OPTIMIZER'),reviewer=configuredModelRole('JUDGE');
  if(!optimizer.adapter||!reviewer.adapter)throw new Error('请配置优化模型和独立审查模型');
  const published=JSON.parse(readFileSync(new URL('../../contracts/runtime-builder/finance.runtime-build-requirements.v3.schema.json',import.meta.url),'utf8'));
  return {diagnose:createImprovementDiagnoser({adapter:optimizer.adapter,model:optimizer.model,
    capabilityFormat:{$ref:'#/$defs/capability',$defs:{capability:published.$defs.capability,jsonSchema:published.$defs.jsonSchema}}}),
    review:createEffectReviewer({adapter:reviewer.adapter,model:reviewer.model})};
}
