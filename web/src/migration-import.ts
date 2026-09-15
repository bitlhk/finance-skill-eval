import {unzipSync} from 'fflate';

export type ImportResult={name:string;status:'IMPORTED'|'FAILED';error?:string};
export async function importMigrationFiles(files:File[],consume:(zip:Uint8Array,name:string)=>Promise<void>){
  if(!files.length||files.length>10)throw new Error('每批请选择 1 至 10 个独立 Skill 文件');
  const results:ImportResult[]=[];
  // Sequential intake bounds parsing and diagnosis work; one invalid file does not abort the batch.
  for(const file of files){
    try{
      if(file.size>8*1024*1024)throw new Error('单个文件不能超过 8 MB');
      const ext=file.name.split('.').at(-1)?.toLowerCase();
      if(ext!=='zip')throw new Error('仅支持迁移源码 ZIP；根目录必须是 skill/ 和可选的 tool/');
      const bytes=new Uint8Array(await file.arrayBuffer()),names=Object.keys(unzipSync(bytes)).filter(name=>!name.endsWith('/'));
      if(!names.includes('skill/SKILL.md'))throw new Error('缺少 skill/SKILL.md，或 ZIP 外层多套了一层目录');
      if(names.filter(name=>/(^|\/)skill\.md$/iu.test(name)).length!==1)throw new Error('ZIP 中必须且只能包含一个 skill/SKILL.md');
      const invalid=names.find(name=>!name.startsWith('skill/')&&!name.startsWith('tool/'));
      if(invalid)throw new Error(`ZIP 根目录只能包含 skill/ 和 tool/：${invalid}`);
      await consume(bytes,file.name);results.push({name:file.name,status:'IMPORTED'});
    }catch(e){const message=e instanceof Error?e.message:String(e);results.push({name:file.name,status:'FAILED',error:/invalid zip|unexpected EOF/i.test(message)?'ZIP 文件损坏或格式不正确，请重新打包':message});}
  }
  return results;
}
