import {expect,it} from 'vitest';
import {zipSync,strToU8,unzipSync} from 'fflate';
import {importMigrationFiles} from '../web/src/migration-import.js';

it('passes arbitrary source layouts through unchanged and wraps standalone Markdown',async()=>{
  const archive=zipSync({'original/project/instructions.md':strToU8('legacy instructions'),'original/project/sdk/tool.py':strToU8('def lookup(): pass'),'README.md':strToU8('project notes')});
  const markdown='# Legacy method\n\nUse references without inventing facts.';
  const collected:Uint8Array[]=[];
  const results=await importMigrationFiles([new File([archive],'source.zip'),new File([markdown],'method.MD')],async bytes=>{collected.push(bytes);});
  expect(results.map(r=>r.status)).toEqual(['IMPORTED','IMPORTED']);
  expect(collected[0]).toEqual(archive);
  expect(Buffer.from(unzipSync(collected[1]!)['SKILL.md']!).toString()).toBe(markdown);
});

it('isolates server archive rejections and oversized files while continuing the batch',async()=>{
  const good=zipSync({'SKILL.md':strToU8('method')});
  const files=[new File(['broken'],'broken.zip'),new File([new Uint8Array(8*1024*1024+1)],'large.md'),new File([good],'good.zip')];
  const consumed:string[]=[];
  const results=await importMigrationFiles(files,async(bytes,name)=>{consumed.push(name);unzipSync(bytes);});
  expect(results.map(r=>r.status)).toEqual(['FAILED','FAILED','IMPORTED']);
  expect(results[0]?.error).toContain('ZIP 文件损坏');
  expect(results[1]?.error).toContain('8 MB');
  expect(consumed).toEqual(['broken.zip','good.zip']);
});
