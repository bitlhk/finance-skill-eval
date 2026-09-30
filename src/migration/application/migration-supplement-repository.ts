import type { Supplement } from '../domain/migration-dependency.js';

export type MigrationSupplementRecord = {
  revision:number;
  items:Supplement[];
};

export interface MigrationSupplementRepository {
  get(id:string):Promise<MigrationSupplementRecord>;
  save(id:string,item:Supplement):Promise<MigrationSupplementRecord>;
  digest(record:MigrationSupplementRecord):string;
  unpack(dependencyId:string,filename:string,bytes:Buffer):Record<string,string>;
}
