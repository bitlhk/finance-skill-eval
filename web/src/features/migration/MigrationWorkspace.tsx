import { api } from '../../api-client';
import type { Catalog, SkillAsset } from '../../types';
import { MigrationTaskPanel } from './MigrationTaskPanel';
export function MigrationWorkspace({catalog,source,onChanged}: {
  catalog:Catalog;source:SkillAsset|null;onChanged():Promise<void>;onUseAsset(asset:SkillAsset):Promise<void>;
}) {
  return <div className="workspace"><section className="workspace-header"><div><span className="eyebrow">SKILL MIGRATION</span><h1>Skill 迁移</h1></div></section>
    <MigrationTaskPanel catalog={catalog} api={api} onChanged={onChanged} source={source}/></div>;
}
