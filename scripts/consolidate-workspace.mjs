/** Offline, explicit-source recovery. Never modify a source or an existing target. */
import {createHash} from 'node:crypto';
import {copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const inside=(parent,child)=>{const relative=path.relative(parent,child);return relative===''||(!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative));};
async function absent(directory){
  try{await lstat(directory);}catch(error){if(error.code==='ENOENT')return;throw error;}
  throw new Error(`Directory already exists: ${directory}`);
}
async function files(directory,relative=''){
  const result=[];
  for(const entry of await readdir(path.join(directory,relative),{withFileTypes:true})){
    const name=path.join(relative,entry.name);
    if(entry.isSymbolicLink())throw new Error(`Symbolic links are not supported: ${name}`);
    if(entry.isDirectory())result.push(...await files(directory,name));
    else if(entry.isFile())result.push(name);
    else throw new Error(`Unsupported workspace entry: ${name}`);
  }
  return result.sort();
}
async function copyChecked(source,target,expected){
  await mkdir(path.dirname(target),{recursive:true});
  await copyFile(source,target);
  if(digest(await readFile(target))!==expected)throw new Error(`Source changed during recovery: ${source}`);
}
export async function consolidateWorkspace(plan){
  if(!Array.isArray(plan.sources)||!plan.sources.length)throw new Error('Explicit sources are required');
  if(typeof plan.target!=='string'||typeof plan.archive!=='string')throw new Error('Target and archive are required');
  const sources=await Promise.all(plan.sources.map(source=>realpath(source)));
  const allSources=[...new Set([...sources,...await Promise.all((plan.archiveSources??[]).map(source=>realpath(source)))])];
  // Resolve output parents too: junction aliases must not bypass overlap checks.
  const resolveOutput=async value=>path.join(await realpath(path.dirname(path.resolve(value))),path.basename(value));
  const target=await resolveOutput(plan.target),archive=await resolveOutput(plan.archive);
  for(const a of [...allSources,target,archive])for(const b of [target,archive]){
    if(a===b&&(a===target||a===archive))continue;
    if(inside(a,b)||inside(b,a))throw new Error(`Overlapping workspace paths: ${a}, ${b}`);
  }
  if(target===archive||allSources.includes(target)||allSources.includes(archive))throw new Error('Overlapping workspace paths');
  await absent(target);await absent(archive);
  const projectSources=new Map();
  for(const [id,source] of Object.entries(plan.projectSources??{})){
    if(!/^(migration|bundle)-[a-f0-9-]+$/u.test(id))throw new Error('Invalid preferred project ID');
    const resolved=await realpath(source);
    if(!sources.includes(resolved))throw new Error('Preferred project source must be an active source');
    await readFile(id.startsWith('bundle-')?path.join(resolved,'migration-tasks','tasks',`${id}.json`):path.join(resolved,'migrations',`${id}.json`));
    projectSources.set(id,resolved);
  }
  const inventory=new Map(),selected=new Map(),conflicts=[];
  for(const source of allSources){
    const rows=[];
    for(const relative of await files(source)){
      const sha256=digest(await readFile(path.join(source,relative)));
      rows.push({path:relative,sha256});
    }
    inventory.set(source,rows);
  }
  // A unified task and all its snapshots must come from the same source.
  // Missing snapshots in the selected source must not be silently repaired with
  // files from a different run, even when their filenames happen to match.
  const taskSources=new Map();
  for(const source of sources)for(const row of inventory.get(source)){
    const parts=row.path.split(path.sep);
    if(parts.length===3&&parts[0]==='migration-tasks'&&parts[1]==='tasks'&&parts[2].endsWith('.json')){
      const id=path.basename(parts[2],'.json');taskSources.set(id,projectSources.get(id)??source);
    }
  }
  for(const source of sources)for(const row of inventory.get(source)){
    const relative=row.path,parts=relative.split(path.sep),previous=selected.get(relative);
    const taskId=parts[0]==='migration-tasks'?(parts[1]==='tasks'?path.basename(parts[2]??'','.json'):parts[1]==='snapshots'?parts[2]:null)
      :parts[0]==='migration-activity'?path.basename(relative,'.json'):null;
    if(taskId&&taskSources.has(taskId)&&taskSources.get(taskId)!==source)continue;
    const projectId=['migrations','migration-runtime-config'].includes(parts[0])?path.basename(relative,'.json'):null;
    if(projectId&&projectSources.has(projectId)&&projectSources.get(projectId)!==source)continue;
    if(previous&&previous.sha256!==row.sha256){
      // Asset bytes are immutable even when the surrounding project state changes.
      if(parts[0]==='skills'&&parts[1]==='assets')throw new Error(`Conflicting immutable asset: ${relative}`);
      conflicts.push({path:relative,previousSource:previous.source,selectedSource:source,previousSha256:previous.sha256,selectedSha256:row.sha256});
    }
    selected.set(relative,{...row,source});
  }
  // Validate source and candidate references before writing any output.
  for(const [relative,row] of selected){
    if(relative.startsWith(`migration-tasks${path.sep}tasks${path.sep}`)&&relative.endsWith('.json')){
      const task=JSON.parse(await readFile(path.join(row.source,relative),'utf8'));
      if(task.schemaVersion!=='finance.skill-migration.task.v1')throw new Error(`Unsupported task protocol: ${relative}`);
      if(path.basename(relative,'.json')!==task.id)throw new Error(`Task ID mismatch: ${relative}`);
      for(const reference of [{id:'source',digest:task.source?.digest},...(task.candidates??[])]){
        const snapshot=selected.get(path.join('migration-tasks','snapshots',task.id,`${reference.id}.json`));
        if(!snapshot||snapshot.source!==row.source)throw new Error(`Missing task snapshot: ${task.id}/${reference.id}`);
        const saved=JSON.parse(await readFile(path.join(snapshot.source,snapshot.path),'utf8'));
        if(!reference.digest||saved.digest!==reference.digest)throw new Error(`Task snapshot digest mismatch: ${task.id}/${reference.id}`);
      }
      if(task.currentCandidateId&&!(task.candidates??[]).some(candidate=>candidate.id===task.currentCandidateId))throw new Error(`Missing current candidate: ${task.id}`);
      continue;
    }
    if(relative.split(path.sep)[0]!=='migrations'||!relative.endsWith('.json'))continue;
    const project=JSON.parse(await readFile(path.join(row.source,relative),'utf8'));
    if(project.schemaVersion!=='finance.skill-migration.v2')continue;
    for(const asset of [project.source,project.candidate,...(project.candidateHistory??[]).map(item=>item.asset)].filter(Boolean)){
      const recordRow=selected.get(path.join('skills','records',`${asset.assetId}.json`));
      if(!recordRow)throw new Error(`Missing Skill record for ${project.id}: ${asset.assetId}`);
      const record=JSON.parse(await readFile(path.join(recordRow.source,recordRow.path),'utf8'));
      if(record.artifactSha256!==asset.artifactSha256||!selected.has(path.join('skills','assets',asset.assetId,asset.skillFile)))throw new Error(`Skill reference mismatch: ${asset.assetId}`);
    }
    for(const run of project.runs??[])if(!selected.has(path.join('runs',`${run.jobId}.json`)))throw new Error(`Missing run for ${project.id}: ${run.jobId}`);
  }
  await mkdir(archive);await mkdir(target);
  const backups=[];
  for(const [index,source] of allSources.entries()){
    const directory=path.join(archive,`source-${String(index).padStart(3,'0')}`);
    await mkdir(directory);
    for(const row of inventory.get(source))await copyChecked(path.join(source,row.path),path.join(directory,row.path),row.sha256);
    backups.push({source,directory,files:inventory.get(source)});
  }
  for(const [relative,row] of selected)await copyChecked(path.join(row.source,relative),path.join(target,relative),row.sha256);
  const manifest={schemaVersion:'finance.workspace-consolidation.v1',createdAt:new Date().toISOString(),target,archive,
    projectSources:Object.fromEntries(projectSources),backups,conflicts,selected:[...selected.values()]};
  await writeFile(path.join(archive,'manifest.json'),JSON.stringify(manifest,null,2));
  return {target,archive,files:selected.size,conflicts:conflicts.length,projects:[...selected.keys()].filter(name=>(name.startsWith(`migrations${path.sep}`)||name.startsWith(`migration-tasks${path.sep}tasks${path.sep}`))&&name.endsWith('.json')).length};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    if(!process.argv[2])throw new Error('Usage: node scripts/consolidate-workspace.mjs <plan.json>');
    console.log(JSON.stringify(await consolidateWorkspace(JSON.parse(await readFile(process.argv[2],'utf8'))),null,2));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
