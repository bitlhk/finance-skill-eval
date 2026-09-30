import { z } from "zod";
import { modelRefSchema } from "../contracts.js";

export { createEnvironmentSchema, environmentRecordSchema, type EnvironmentRecord } from "../shared/contracts/environment.js";

export {runConfigurationSchema,serviceEnvironmentReferenceSchema,type RunConfiguration} from '../shared/contracts/run-configuration.js';
export {manualPreparationSchema} from '../shared/contracts/manual-preparation.js';

export const prepareSkillSchema = z.strictObject({
  domainContext: z.string().max(8_000).optional(),
  role: z.string().max(120).optional(),
  maximumCases: z.number().int().min(1).max(8).default(4),
  model: modelRefSchema.optional(),
});
