import type {RunConfiguration} from '../../shared/contracts/run-configuration.js';

export type MigrationRunDeclaration={
  pair:'AB'|'BC'|'AC'|'SC'|'CC';
  configuration:RunConfiguration;
  dataSnapshot:string;
  permissionBasis:string;
  sourceProjectRef:string;
  dependencyLockRef:string;
};
