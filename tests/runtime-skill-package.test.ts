import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {unzipSync} from 'fflate';
import {runtimeSkillPackage} from '../src/runtime-skill-package.js';

describe('Runtime Skill archive identity',()=>{
  it('preserves a nested document and sibling executable projects without synthetic aliases',()=>{
    const archive=Object.fromEntries(Object.entries({'skill/SKILL.md':'Use references/rules.md.',
      'skill/references/rules.md':'Rules','skill/scripts/run.py':'print(1)','mcp/server.py':'print(2)',
      'README.md':'Archive readme','skill/README.md':'Skill readme'}).map(([p,c])=>[p,Buffer.from(c)]));
    const source=runtimeSkillPackage({skillId:'test',version:'1',artifactSha256:'a'.repeat(64),skillFile:'skill/SKILL.md',archive});
    expect(source.skillFile).toBe('skill/SKILL.md');
    expect(source.files).toEqual(Object.fromEntries(Object.entries(archive).map(([p,c])=>[p,c.toString()])));
    expect(source.files).not.toHaveProperty('SKILL.md');
    const zip=Buffer.from(source.archiveBase64!,'base64');
    expect(createHash('sha256').update(zip).digest('hex')).toBe(source.archiveSha256);
    expect(Object.keys(unzipSync(zip))).toEqual(Object.keys(archive));
    expect(source.artifactSha256).toBe('a'.repeat(64));
  });
  it('omits the additive entrypoint for an existing root document',()=>{
    const source=runtimeSkillPackage({skillId:'test',version:'1',artifactSha256:'a'.repeat(64),skillFile:'SKILL.md',archive:{'SKILL.md':Buffer.from('Hello')}});
    expect(source.skillFile).toBeUndefined();expect(source.instructions).toBe('Hello');
  });
  it('rejects a document missing from the verified archive',()=>{
    expect(()=>runtimeSkillPackage({skillId:'test',version:'1',artifactSha256:'a'.repeat(64),skillFile:'skill/SKILL.md',archive:{}})).toThrow(/missing/);
  });
});
