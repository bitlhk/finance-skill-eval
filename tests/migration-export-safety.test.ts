import {expect,it} from 'vitest';
import {assertMigrationExportSafe} from '../src/migration/domain/migration-export-safety.js';
const files=(name:string,value:string)=>({[name]:Buffer.from(value)});
it('allows conspicuously synthetic test fixtures without excluding tests from scanning',()=>{
  expect(()=>assertMigrationExportSafe(files('package/tests/conftest.py','API_KEY="test-service-key"'))).not.toThrow();
  expect(()=>assertMigrationExportSafe(files('package/tests/test_model.py','API_KEY="local-test-only"'))).not.toThrow();
  for(const name of ['package/app/config.py','package/tests/conftest.py']){
    expect(()=>assertMigrationExportSafe(files(name,'API_KEY="sk-sensitive-value"'))).toThrow();
  }
  expect(()=>assertMigrationExportSafe(files('package/app/config.py','API_KEY="test-service-key"'))).toThrow();
  expect(()=>assertMigrationExportSafe(files('package/tests/.env','API_KEY="local-test-only"'))).toThrow();
  expect(()=>assertMigrationExportSafe(files('package/tests/key.txt','-----BEGIN PRIVATE KEY-----\nAPI_KEY="sk-sensitive-value"'))).toThrow();
});
