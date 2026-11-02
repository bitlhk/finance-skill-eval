import path from 'node:path';
import {readJson} from '../service/file-store.js';
import {migrationProjectIdSchema,parseMigrationProject,type MigrationProject} from '../migration/domain/migration-project.js';

/** Read only the historical record needed to resolve an existing service binding. */
export async function readHistoricalMigrationRecord(root:string,id:string):Promise<MigrationProject>{
  if(!migrationProjectIdSchema.safeParse(id).success){
    throw Object.assign(new Error('迁移记录 ID 不合法'),{statusCode:400});
  }
  let raw:unknown;
  try{raw=await readJson<unknown>(path.join(root,'migrations',`${id}.json`));}
  catch(error){
    if((error as NodeJS.ErrnoException).code==='ENOENT'){
      throw Object.assign(new Error('迁移记录不存在'),{statusCode:404});
    }
    throw error;
  }
  if((raw as {schemaVersion?:string})?.schemaVersion!=='finance.skill-migration.v2'){
    throw Object.assign(new Error('旧版迁移记录不再升级，请使用原始 Skill 新建迁移'),{statusCode:410});
  }
  const project=parseMigrationProject(raw);
  if(project.id!==id)throw new Error(`迁移记录 ID 与请求不一致: ${id}`);
  return project;
}
