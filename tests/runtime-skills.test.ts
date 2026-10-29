import { expect, it } from 'vitest';
import { snapshot } from '../src/migration/tasks/domain/task-model.js';
import { runtimeSkillSetFromFiles, skillSetFileStats, runtimeSkillSetSchema } from '../src/shared/contracts/runtime-skills.js';

it.each([1,3])('transfers %i independent instruction Skills with no archive, assets or project files', count => {
  const source=snapshot(Object.fromEntries(Array.from({length:count},(_,i)=>[`skills/s${i}/SKILL.md`,Buffer.from(`---\nname: s${i}\ndescription: Task\n---\nUse the stated policy.`).toString('base64')])),'r1');
  const transfer=runtimeSkillSetFromFiles(source);
  expect(transfer.skills).toHaveLength(count);expect(transfer.assets).toBeUndefined();
  expect(transfer.skills.every(skill=>skill.files===undefined)).toBe(true);
  expect(JSON.stringify(transfer)).not.toMatch(/archive|bundle|package\.json|pyproject/);
  expect(transfer.contentDigest).toBe(source.digest);expect(skillSetFileStats(transfer).count).toBe(count);
});

it('keeps member resources and shared binary assets separate without changing frozen bytes',()=>{
  const files={'skills/a/SKILL.md':Buffer.from('---\nname: a\ndescription: Task\n---\nInstructions\r\n').toString('base64'),
    'skills/a/ref.txt':Buffer.from('resource\r\n').toString('base64'),'shared/image.bin':Buffer.from([0,255,128]).toString('base64')};
  const transfer=runtimeSkillSetFromFiles(snapshot(files,'r1'));
  expect(transfer.skills[0]!.files).toEqual({'skills/a/ref.txt':files['skills/a/ref.txt']});
  expect(transfer.assets).toEqual({'shared/image.bin':files['shared/image.bin']});
  expect(skillSetFileStats(transfer).count).toBe(3);
  expect(()=>runtimeSkillSetSchema.parse({...transfer,skills:[]})).toThrow();
  expect(()=>runtimeSkillSetSchema.parse({...transfer,bundle:{}})).toThrow();
});
