import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {writeJsonAtomic} from './file-store.js';
import {KeyedQueue} from '../shared/keyed-queue.js';
import {canonicalSha256} from '../shared/json-canonicalization.js';
import {readEvidencePointer} from '../evaluation/domain/evidence-resources.js';
import {calibrationSummary,reviewConsensus,reviewImportSchema,type HumanReview,type ReviewSource,type ReviewTarget} from '../evaluation/domain/human-review.js';
import {calibrateJudges,type CalibrationEvaluation} from '../evaluation/application/judge-calibration.js';

export type ReviewMaterial={digest:string;targets:ReviewTarget[];resources:unknown;evaluations?:CalibrationEvaluation[]};
export class HumanReviewStore{
  private readonly queue=new KeyedQueue();
  constructor(private readonly directory:string,private readonly resolve:(source:ReviewSource)=>Promise<ReviewMaterial>){}
  private file(source:ReviewSource){return path.join(this.directory,'evaluation-reviews',canonicalSha256(source)+'.json');}
  private async records(source:ReviewSource):Promise<HumanReview[]>{
    try{return JSON.parse(await readFile(this.file(source),'utf8'));}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
  }
  async get(source:ReviewSource){
    const material=await this.resolve(source),history=await this.records(source);
    const records=history.filter(record=>record.sourceDigest===material.digest);
    return {source,sourceDigest:material.digest,targets:material.targets,records,history,staleRecordCount:history.length-records.length,
      summary:calibrationSummary(material.targets,records),evidence:material.resources,
      calibrations:calibrateJudges(material.targets,records,material.evaluations??[])};
  }
  async append(input:unknown){
    const request=reviewImportSchema.parse(input);
    return this.queue.run(canonicalSha256(request.source),async()=>{
      const material=await this.resolve(request.source);
      if(material.digest!==request.sourceDigest)throw Object.assign(new Error('评测材料已变化，请刷新后复核'),{statusCode:409});
      const history=await this.records(request.source);
      if(history.length+request.entries.length>10000)throw Object.assign(new Error('复核历史已达保存上限'),{statusCode:409});
      const current=history.filter(r=>r.sourceDigest===material.digest);
      const added:HumanReview[]=[];
      for(const entry of request.entries){
        const target=material.targets.find(t=>t.id===entry.targetId);
        if(!target||!target.outcomes.includes(entry.outcome))throw Object.assign(new Error('标注目标或结论不适用于当前报告'),{statusCode:400});
        if(entry.evidenceRefs.some(ref=>!ref.startsWith(target.evidenceRoot+'/')||readEvidencePointer(material.resources,ref)===undefined))throw Object.assign(new Error('引用必须指向该案例中实际保存的证据'),{statusCode:400});
        const scoped=[...current,...added],consensus=reviewConsensus(target,scoped);
        if(entry.kind==='ANNOTATION'){
          const previous=consensus.annotations.find(r=>r.reviewer===entry.reviewer);
          if(previous?.id!==entry.supersedes||entry.resolves.length)throw Object.assign(new Error('标注意见已变化；修改时必须引用该标注者的当前记录'),{statusCode:409});
        }else{
          if(entry.supersedes||consensus.annotations.length<2||new Set(consensus.annotations.map(r=>r.outcome)).size<2
            ||JSON.stringify([...entry.resolves].sort())!==JSON.stringify(consensus.annotations.map(r=>r.id).sort()))
            throw Object.assign(new Error('争议复核必须引用全部当前分歧意见'),{statusCode:409});
        }
        added.push({...entry,id:randomUUID(),createdAt:new Date().toISOString(),sourceDigest:material.digest});
      }
      if((await this.resolve(request.source)).digest!==material.digest)throw Object.assign(new Error('保存前评测材料已变化'),{statusCode:409});
      await writeJsonAtomic(this.file(request.source),[...history,...added]);
      return this.get(request.source);
    });
  }
}
export type HumanReviewView=Awaited<ReturnType<HumanReviewStore['get']>>;
