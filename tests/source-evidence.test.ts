import {it,expect} from 'vitest';
import {SourceEvidenceValidator,normalizeSourceNewlines} from '../src/migration/domain/migration-source-evidence.js';
it('matches CRLF, LF and CR in either source or citation and reports the real line',()=>{
 for(const newline of ['\r\n','\n','\r'])for(const quoted of ['\r\n','\n','\r']){
  const text=['# header','def query():','    return "value"',''].join(newline),view=new SourceEvidenceValidator({'code.py':text});
  const snippet=['def query():','    return "value"'].join(quoted);
  expect(view.find('code.py',snippet)?.line).toBe(2);expect(view.containsAtLines('code.py',snippet,2,3)).toBe(true);expect(view.containsAtLines('code.py',snippet,1,2)).toBe(false);
 }
});
it('does not erase indentation, quoted spaces or invented content',()=>{
 const view=new SourceEvidenceValidator({'code.py':'def query():\r\n    return "a  b"\r\n'});
 expect(view.find('code.py','def query():\n return "a  b"')).toBeNull();
 expect(view.find('code.py','return "a b"')).toBeNull();expect(view.find('missing.py','def query():')).toBeNull();expect(view.find('code.py','')).toBeNull();
});
it('keeps original data unchanged and scopes cached normalization to one snapshot',()=>{
 const files={'code.py':'first\r\nsecond\rthird'},view=new SourceEvidenceValidator(files);
 expect(view.text('code.py')).toBe('first\nsecond\nthird');expect(files['code.py']).toBe('first\r\nsecond\rthird');
 files['code.py']='updated';expect(view.text('code.py')).toBe('first\nsecond\nthird');expect(new SourceEvidenceValidator(files).text('code.py')).toBe('updated');expect(normalizeSourceNewlines('a\r\nb\rc\n')).toBe('a\nb\nc\n');
});
