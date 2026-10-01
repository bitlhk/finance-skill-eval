import {strToU8,zipSync} from 'fflate';
import YAML from 'yaml';
import {z} from 'zod';
import {canonicalSha256} from '../../shared/json-canonicalization.js';
import type {NativeBindingTarget,NativeSkillBindings} from '../../shared/contracts/native-tool-catalog.js';
import type {MigrationProjectStore} from './migration-project-store.js';
import type {MigrationSkillRepository} from './migration-skill-repository.js';
import {migrationConflict as conflict} from './migration-errors.js';
import {validateSkill} from '../domain/migration-skill-validator.js';

/** Explicit reuse of admitted tools, not source-code migration or permission granting. */
export class MigrationNativeBindingService{
  constructor(private readonly projects:MigrationProjectStore,private readonly skills:MigrationSkillRepository){}

  async bind(id:string,input:unknown,targets:NativeBindingTarget[]){
    const parsed=z.strictObject({baseAssetId:z.string().min(1),
      tools:z.array(z.string().min(1)).min(1).max(64),acknowledgeContracts:z.literal(true)}).parse(input);
    return this.projects.runExclusive(id,async()=>{
      const project=await this.projects.get(id),base=project.candidate??project.source;
      if(base.assetId!==parsed.baseAssetId)return conflict('资产已变化，请重新检查并绑定');
      const inspection=project.inspection;
      if(!inspection||inspection.assetId!==base.assetId||inspection.staticAnalysis?.status!=='COMPLETE')
        return conflict('请先完成当前版本的完整静态诊断');
      if(inspection.dependencyAnalysis?.dependencies.length)
        return conflict('此入口仅复用已准入工具；额外运行依赖需先完成适配');
      if(inspection.skill.findings.some(f=>f.severity==='ERROR'&&!['FRONTMATTER_MISSING','NAME_REQUIRED','DESCRIPTION_REQUIRED'].includes(f.code)))
        return conflict('当前 Skill 还有不能由原生绑定修复的规范错误，请先修改源文件');
      const names=[...new Set(parsed.tools)].sort();
      const required=[...new Set([...inspection.tools.map(t=>t.name),...(inspection.runtimeCapabilities??[]).map(t=>t.name)])].sort();
      if(names.length!==parsed.tools.length||JSON.stringify(names)!==JSON.stringify(required))
        return conflict('必须逐项绑定本次诊断的全部工具，不能遗漏或增加工具');
      if(!targets.length||targets.length>2||new Set(targets.map(t=>t.catalog.runtime.type)).size!==targets.length)
        return conflict('请选择一至两个不同的原生 Runtime');
      const tools:NativeSkillBindings['tools']=[];
      for(const name of names){
        const entries=targets.map(t=>t.catalog.contracts.find(c=>c.nativeToolNames.length===1&&c.nativeToolNames[0]===name));
        if(entries.some(e=>!e))return conflict(`工具 ${name} 尚未在所选环境中准入，不能按名称替换实现`);
        const entry=entries[0]!,contractDigest=canonicalSha256(entry.contract),constraintsDigest=canonicalSha256(entry.constraints);
        if(entries.some(e=>canonicalSha256(e!.contract)!==contractDigest||canonicalSha256(e!.constraints)!==constraintsDigest))
          return conflict(`工具 ${name} 的两端合同或执行约束不一致`);
        const source=inspection.tools.find(t=>t.name===name);
        const runtime=inspection.runtimeCapabilities?.find(t=>t.name===name);
        if((source?.inputSchema&&canonicalSha256(source.inputSchema)!==canonicalSha256(entry.contract.inputSchema))
            ||(source?.outputSchema&&canonicalSha256(source.outputSchema)!==canonicalSha256(entry.contract.outputSchema))
            ||(runtime?.contract&&canonicalSha256(runtime.contract)!==contractDigest)
            ||(runtime?.constraints&&canonicalSha256(runtime.constraints)!==constraintsDigest))
          return conflict(`工具 ${name} 的源合同与已准入合同不一致，需要显式适配`);
        tools.push({name,contractDigest,constraintsDigest});
      }
      const archive=await this.skills.readArchive(base.assetId);
      const skillRoot=base.skillFile.includes('/')?base.skillFile.slice(0,base.skillFile.lastIndexOf('/')+1):'';
      if(skillRoot&&Object.keys(archive).some(name=>!name.startsWith(skillRoot)))
        return conflict('Skill 目录外还有文件，请整理为单一方法目录后导入；未丢弃任何源文件');
      const files=Object.fromEntries(Object.entries(archive).map(([name,bytes])=>[name.slice(skillRoot.length),bytes]));
      const entry=base.skillFile.slice(skillRoot.length);
      if(entry!=='SKILL.md')return conflict('原生方法入口必须命名为 SKILL.md，请修改后重新导入');
      if(Object.keys(files).some(p=>!/\.(md|txt|json|ya?ml)$/iu.test(p)))
        return conflict('原生复用入口仅接收方法与声明文件，不迁移或执行上传代码');
      const source=Buffer.from(files[entry]!).toString('utf8');
      const match=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(source);
      const meta=match?YAML.parse(match[1]!):{};
      if(!meta||typeof meta!=='object'||Array.isArray(meta))return conflict('Skill 元数据必须为对象');
      if(meta['allowed-tools']!==undefined){
        const declared=Array.isArray(meta['allowed-tools'])?meta['allowed-tools']:String(meta['allowed-tools']).split(/[\s,]+/u).filter(Boolean);
        if(JSON.stringify([...declared].sort())!==JSON.stringify(names))return conflict('工具声明与诊断结果不一致，请补齐诊断后重试');
      }
      const version=`0.1.0-native.${(project.candidateHistory?.length??0)+1}`;
      const metadata={...meta,name:base.skillId,version,description:base.description||base.displayName,'allowed-tools':names};
      files[entry]=strToU8(`---\n${YAML.stringify(metadata)}---\n${match?source.slice(match[0].length):source}`);
      const bindings:NativeSkillBindings={schemaVersion:'finance.native-skill-bindings.v1',sourceDigest:base.artifactSha256,
        targets:targets.map(t=>({environmentId:t.environmentId,runtime:t.catalog.runtime,catalogDigest:t.catalog.catalogDigest,artifactSha256:t.catalog.artifactSha256})),tools};
      files['references/finance-native-bindings.txt']=strToU8(JSON.stringify(bindings,null,2)+'\n');
      const checked=validateSkill(Object.fromEntries(Object.entries(files).map(([name,bytes])=>[name,Buffer.from(bytes).toString('utf8')])),'SKILL.md');
      if(checked.status!=='COMPLIANT')return conflict('候选仍有 Skill 规范错误，请修改源文件后重新绑定');
      const candidate=await this.skills.uploadZip(Buffer.from(zipSync(files)));
      project.candidate=candidate;
      project.nativeBindings={candidateDigest:candidate.artifactSha256,bindings,recordedAt:new Date().toISOString()};
      project.candidateNotes='显式复用已准入原生工具；冻结合同与目标环境。未生成银行代码，未正式发布，实际执行仍须验证。';
      // Preserve the analyzer evidence; binding is a separate operation, not a rewritten diagnosis.
      delete project.portableGenerations;delete project.portableGenerationDiff;
      (project.candidateHistory??=[]).push({asset:candidate,notes:project.candidateNotes,recordedAt:new Date().toISOString(),kind:'migration'});
      await this.projects.save(project);
      return project;
    });
  }
}
