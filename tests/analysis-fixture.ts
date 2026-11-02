import {strToU8} from 'fflate';
import {stableToolId,type ToolInspection,type ProjectInspection} from '../src/migration/domain/migration-model.js';

export function toolFixture(input: Partial<ToolInspection> & { name: string; sourcePaths: string[] }): ToolInspection {
  return {
    toolId: stableToolId(input.name, input.sourcePaths),
    language: 'Python', kind: 'RUNTIME_BOUND', portability: 'RUNTIME_BOUND',
    inputSchema: null, outputSchema: null, samples: [], evidence: [], findings: [],
    recommendedForm: 'SCRIPT', recommendedLanguage: 'python', recommendationReason: '夹具',
    ...input,
  };
}

export function inspectionFixture(tools: ToolInspection[], assetId = 'asset'): ProjectInspection {
  return { assetId, assetDigest: 'd'.repeat(64), inspectedAt: new Date().toISOString(), tools,
    skill: { status: 'COMPLIANT', findings: [] }, scriptsExecuted: false };
}

export const archiveOf = (files: Record<string, string>) =>
  Object.fromEntries(Object.entries(files).map(([name, content]) => [name, strToU8(content)]));
