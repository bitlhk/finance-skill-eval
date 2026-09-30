import type { EvalPack } from '../../contracts.js';

export interface MigrationEvalPackCatalog {get(packId:string):EvalPack|null}
