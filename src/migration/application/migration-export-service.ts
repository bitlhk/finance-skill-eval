import { zipSync } from 'fflate';
import type { MigrationSkillRepository } from './migration-skill-repository.js';
import type { MigrationProjectStore } from './migration-project-store.js';
import { migrationConflict as conflict } from './migration-errors.js';

export class MigrationExportService {
  constructor(
    private readonly projects:MigrationProjectStore,
    private readonly skills:MigrationSkillRepository,
  ) {}

  async exportCandidate(id:string) {
    return (await this.exportPackage(id)).archive;
  }

  async exportPackage(id:string) {
    const value=await this.projects.get(id);
    if (!value.candidate) return conflict('请先生成候选');
    const archivedFiles=await this.skills.readArchive(value.candidate.assetId);
    // Keep the export boundary defensive even for candidates created before the packager learned
    // to reject workspace fixtures from a model-authored document manifest.
    const files=Object.fromEntries(Object.entries(archivedFiles).filter(([name])=>{
      const relative=name.startsWith('skill/')?name.slice('skill/'.length):name;
      return !relative.startsWith('workspace/')&&!relative.startsWith('references/workspace/');
    }));
    if (['migration-manifest.json','migration-report.json'].some(name=>name in files)) return conflict('候选里已存在导出要用的元数据路径，未覆盖任何文件');
    for(const [name,bytes] of Object.entries(files)){
      if(/(^|\/)(\.env(?:\..*)?|access-token|id_rsa|id_ed25519)$|\.(pem|key)$/i.test(name)||/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|password|secret|token)\s*[:=]\s*["'][^"'\n]{8,}["']/i.test(Buffer.from(bytes).toString())) {
        return conflict('候选可能包含凭据，请先检查并移除敏感配置；未导出任何文件');
      }
    }
    // The delivery archive contains only the Skill and its tools. Evidence remains in the report API.
    return {archive:Buffer.from(zipSync(files)),candidateDigest:value.candidate.artifactSha256,skillId:value.candidate.skillId};
  }
}
