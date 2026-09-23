import path from 'node:path';
import { buildPreparedEvaluationPack } from '../../shared/prepared-evaluation-pack.js';
import type { MigrationPreparationPackFactory } from '../application/migration-preparation-pack-factory.js';

export class FileMigrationPreparationPackFactory implements MigrationPreparationPackFactory {
  constructor(private readonly dataDirectory:string){}
  build(input:Parameters<MigrationPreparationPackFactory['build']>[0]) {
    return buildPreparedEvaluationPack({...input,sourceFile:path.join(this.dataDirectory,'preparations',`${input.preparation.preparationId}.json`)});
  }
}
