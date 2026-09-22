import {zipSync,strToU8} from 'fflate';

export type ImportResult={name:string;status:'IMPORTED'|'FAILED';error?:string};
export async function importMigrationFiles(files:File[],consume:(zip:Uint8Array,name:string)=>Promise<void>){
  if(!files.length||files.length>10)throw new Error('每批请选择 1 至 10 个独立 Skill 文件');
  const results:ImportResult[]=[];
  // Sequential intake bounds parsing and diagnosis work; one invalid file does not abort the batch.
  for(const file of files){
    try{
      if(file.size>8*1024*1024)throw new Error('单个文件不能超过 8 MB');
      const ext=file.name.split('.').at(-1)?.toLowerCase();
      if(ext!=='zip'&&ext!=='md')throw new Error('仅支持源码 ZIP 或独立 Markdown；工具源码请连同说明文件一起打包');
      // Preserve source layout. Archive safety is checked by the migration upload endpoint;
      // identifying the Skill and its dependencies belongs to diagnosis.
      const bytes=ext==='zip'?new Uint8Array(await file.arrayBuffer()):zipSync({'SKILL.md':strToU8(await file.text())});
      await consume(bytes,file.name);results.push({name:file.name,status:'IMPORTED'});
    }catch(e){const message=e instanceof Error?e.message:String(e);results.push({name:file.name,status:'FAILED',error:/invalid zip|unexpected EOF/i.test(message)?'ZIP 文件损坏或格式不正确，请重新打包':message});}
  }
  return results;
}
