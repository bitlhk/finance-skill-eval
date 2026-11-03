import {runtimeLauncherCapabilitiesSchema} from './runtime-launcher.js';
import type {z} from 'zod';

type Capabilities=z.infer<typeof runtimeLauncherCapabilitiesSchema>;
export type RuntimeFeature=keyof Capabilities['features'];
export function runtimeFeatureIssues(capabilities:Capabilities,features:readonly RuntimeFeature[]):string[]{
  return [...new Set(features)].filter(feature=>capabilities.features[feature]!==true).map(feature=>`FEATURE_UNAVAILABLE_${feature}`);
}
