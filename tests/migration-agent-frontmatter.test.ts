import {expect,it} from 'vitest';
import {validSkillFrontmatter} from '../src/migration/application/migration-implementation-service.js';

it('rejects malformed agent-authored Skill frontmatter before packaging',()=>{
  expect(validSkillFrontmatter('---\nname: migrated\ndescription: Order result: approved\n---\nUse tools.')).toBe(false);
  expect(validSkillFrontmatter('---\nname: migrated\ndescription: "Order result: approved"\n---\nUse tools.')).toBe(true);
  expect(validSkillFrontmatter('---\nname: migrated\ndescription: |\n  Order result: approved\n---\nUse tools.')).toBe(true);
  expect(validSkillFrontmatter('---\nname: migrated\n---\nUse tools.')).toBe(false);
});
