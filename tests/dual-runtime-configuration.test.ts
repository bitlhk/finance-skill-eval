import {expect, it} from 'vitest';
import {dualRuntimeConfiguration} from '../web/src/dual-runtime-configuration';
import {runConfigurationSchema} from '../src/shared/contracts/run-configuration.js';

it('submits explicit independent assessments and equal parameters for ordinary Skill comparison', () => {
  const model = {providerId: 'managed', modelId: 'model', parameters: {temperature: .7}};
  const parameters = {temperature: 0, top_p: 1, max_tokens: 1024};
  const result = dualRuntimeConfiguration(model, parameters);
  const variant = {mode: 'skill_version', skillId: 'method', version: '1.0', artifactSha256: 'a'.repeat(64)};
  const configuration = {packId: 'original', runtime: {type: 'runtime_launcher', environmentId: 'oj'},
    runtimeBindings: {left: {environmentId: 'oj', skillAssetId: 'asset'}, right: {environmentId: 'as', skillAssetId: 'asset'}},
    leftVariant: variant, rightVariant: variant, ...result};
  expect(runConfigurationSchema.parse(configuration).evaluationMode).toBe('candidate_runtime_comparison');
  expect(result.leftExecutionModel).toEqual(result.rightExecutionModel);
  expect(result.executionModel.parameters).toEqual(parameters);
  result.leftExecutionModel.parameters.temperature = .5;
  expect(result.rightExecutionModel.parameters.temperature).toBe(0);
  expect(model.parameters.temperature).toBe(.7);
  expect(runConfigurationSchema.safeParse(configuration).success).toBe(false);
});
