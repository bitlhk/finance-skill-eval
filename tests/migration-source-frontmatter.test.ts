import {expect,it} from 'vitest';
import {snapshot,defaultTaskDescription} from '../src/migration/tasks/domain/task-model.js';
it('preserves malformed source descriptions for diagnosis but rejects malformed generated metadata',()=>{
 const text='---\nname: meetingroom\ndescription:\n会议室修改技能。\nUse when: 修改会议。\nlicense: MIT\nmetadata:\nsource: skill-dir\n---\nCall the real tools.';
 const files={'SKILL.md':Buffer.from(text).toString('base64')};
 const source=snapshot(files,'source');expect(source.files).toEqual(files);expect(source.members[0]?.sourceWarnings).toHaveLength(1);
 const escaped={'SKILL.md':Buffer.from('\\'+text).toString('base64')};
 expect(snapshot(escaped,'source').files).toEqual(escaped);expect(()=>snapshot(escaped,'r1',source)).toThrow();
 expect(defaultTaskDescription(source).goal).toContain('会议室修改技能');
 expect(()=>snapshot(files,'r1',source)).toThrow('头部格式');
 const fixed={'SKILL.md':Buffer.from(text.replace('description:\n会议室修改技能。\nUse when: 修改会议。','description: |\n  会议室修改技能。\n  Use when: 修改会议。')).toString('base64')};
 expect(snapshot(fixed,'r1',source).members[0]?.sourceWarnings).toBeUndefined();
});
it('does not infer missing or ambiguous identities from filenames',()=>{
 for(const header of ['description: Missing name','name: first\nname: second\ndescription:\ntext','name: valid'])
  expect(()=>snapshot({'SKILL.md':Buffer.from('---\n'+header+'\n---\nbody').toString('base64')},'source')).toThrow();
});
