import type {ImprovementDiagnoser} from './diagnosis-port.js';
import type {EffectReviewer} from '../../agents/ports.js';
export type ImprovementAgents={diagnose:ImprovementDiagnoser;review:EffectReviewer};
