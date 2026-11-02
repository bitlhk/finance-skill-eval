import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { AgentCompositionReceipt } from '../shared/contracts/agent-composition.js';

export const agentRoleIds = ['diagnosis', 'migration', 'standardization-review', 'adjustment', 'effect-review', 'improvement-diagnosis', 'criterion-judge'] as const;
export type AgentRoleId = typeof agentRoleIds[number];
export type AdjustmentCapability = 'document' | 'tool' | 'runtime';
export type AdjustmentAssembly = { execution: 'proposal' | 'engineering'; capabilities: AdjustmentCapability[] };
const executionSchema = z.strictObject({
  prompt: z.string().optional(),
  skills: z.array(z.string()).optional(),
  executor: z.enum(['openjiuwen-bundle', 'tool-free-model']), modes: z.array(z.string()),
  tools: z.array(z.string()), conditionalTools: z.array(z.string()), writeScope: z.enum(['none', 'candidate']),
  references: z.array(z.string()), inputContract: z.string(), outputContract: z.string(),
  modelRole: z.enum(['ANALYZER', 'MIGRATION', 'OPTIMIZER', 'JUDGE']), budgetKind: z.enum(['agentIterations', 'singleCompletion']),
});
const definitionSchema = z.strictObject({
  executor: z.enum(['openjiuwen-bundle', 'tool-free-model']), modes: z.array(z.string()),
  prompt: z.string(), skills: z.array(z.string()), references: z.array(z.string()),
  tools: z.array(z.string()), conditionalTools: z.array(z.string()), writeScope: z.enum(['none', 'candidate']),
  inputContract: z.string(), outputContract: z.string(), modelRole: z.enum(['MIGRATION', 'OPTIMIZER', 'JUDGE']),
  budgetKind: z.enum(['agentIterations', 'singleCompletion']),
  capabilitySkills: z.record(z.array(z.string())).optional(),
  executionProfiles: z.record(executionSchema).optional(),
});
const manifestSchema = z.strictObject({ schemaVersion: z.literal('finance.agent-roles.v1'), version: z.string(), roles: z.record(definitionSchema) });
export const compositionDigest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const readTools = ['read_file', 'glob', 'list_files', 'grep', 'submit_result', 'record_result', 'correct_result'];
const toolCeiling: Record<AgentRoleId, readonly string[]> = {
  diagnosis: [...readTools, 'run_scanner'], 'standardization-review': readTools,
  migration: [...readTools, 'write_file', 'edit_file', 'compile_source', 'run_contract_test', 'run_mcp_contract_suite'],
  adjustment: [...readTools, 'write_file', 'edit_file', 'compile_source', 'run_contract_test', 'run_mcp_contract_suite'],
  'effect-review': [], 'improvement-diagnosis': [], 'criterion-judge': [],
};

/** Only operator-installed versions are selectable. Task assets cannot supply definitions. */
export function loadAgentRole(role: AgentRoleId, version = 'v1', assembly?: AdjustmentAssembly) {
  if (!agentRoleIds.includes(role) || !/^v[1-9][0-9]*$/u.test(version)) throw new Error('Unknown agent role/version');
  const root = realpathSync(fileURLToPath(new URL(`../../agent-roles/${version}/`, import.meta.url)));
  const read = (relative: string) => {
    const file = realpathSync(path.resolve(root, relative));
    const resolved = path.relative(root, file);
    if (!resolved || resolved.startsWith('..') || path.isAbsolute(resolved)) throw new Error('Agent resource escapes version root');
    return readFileSync(file, 'utf8').replace(/\r\n/gu, '\n');
  };
  const manifest = manifestSchema.parse(JSON.parse(read('roles.json')));
  if (manifest.version !== version) throw new Error('Agent version mismatch');
  const base = manifest.roles[role];
  if (!base) throw new Error('Agent role missing');
  if (assembly && role !== 'adjustment') throw new Error('Assembly is only supported by adjustment');
  const selection = role === 'adjustment' ? assembly ?? {execution:'proposal', capabilities:['document']} as AdjustmentAssembly : undefined;
  if (selection && (!['proposal','engineering'].includes(selection.execution) || !selection.capabilities.length
      || new Set(selection.capabilities).size !== selection.capabilities.length
      || selection.capabilities.some(c => !['document','tool','runtime'].includes(c) || !base.capabilitySkills?.[c])
      || (selection.execution === 'proposal' && selection.capabilities.includes('runtime')))) throw new Error('Invalid adjustment assembly');
  const profile = selection ? base.executionProfiles?.[selection.execution] : undefined;
  if (selection && !profile) throw new Error('Agent execution profile missing');
  const definition = {...base, ...profile, skills: [...base.skills, ...(profile?.skills??[]), ...(selection?.capabilities.flatMap(c => base.capabilitySkills![c]!) ?? [])]};
  const engineering = role === 'migration' || (role === 'adjustment' && selection?.execution === 'engineering');
  const ceiling = role === 'adjustment' && !engineering ? [] : toolCeiling[role];
  if ([...definition.tools, ...definition.conditionalTools].some(tool => !ceiling.includes(tool))
      || definition.writeScope !== (engineering ? 'candidate' : 'none')
      || definition.executor !== (['adjustment', 'effect-review', 'improvement-diagnosis', 'criterion-judge'].includes(role) && !engineering ? 'tool-free-model' : 'openjiuwen-bundle')) {
    throw new Error('Agent definition exceeds executable permissions');
  }
  const paths = [definition.prompt, ...definition.skills, ...definition.references];
  const texts = paths.map(read);
  const resources = paths.map((path, i) => ({ path, sha256: compositionDigest(texts[i]!) }));
  return { role, version, definition, resources, systemPrompt: texts.join('\n\n'),
    definitionDigest: compositionDigest(JSON.stringify({ definition, resources })) };
}

export function compositionReceipt(composition: ReturnType<typeof loadAgentRole>, input: unknown,
  model: { providerId: string; modelId: string; parameters?: unknown }, budget: AgentCompositionReceipt['budget']): AgentCompositionReceipt {
  return { schemaVersion: 'finance.agent-composition.v1', role: composition.role, version: composition.version, configurationSource: 'REQUEST',
    definitionDigest: composition.definitionDigest, resources: composition.resources, tools: [...composition.definition.tools],
    writeScope: composition.definition.writeScope, inputDigest: compositionDigest(JSON.stringify(input)),
    model: { providerId: model.providerId, modelId: model.modelId, configurationDigest: compositionDigest(JSON.stringify(model)) }, budget };
}
