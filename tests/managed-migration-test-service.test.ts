import {expect,it} from 'vitest';
import {managedMigrationTestService,PROCUREMENT_TEST_SERVICE} from '../src/migration/infrastructure/managed-migration-test-service.js';

it('resolves the pinned fixture and routes external HTTPS through the managed relay',()=>{
  expect(managedMigrationTestService({})).toBeNull();
  const fixture=managedMigrationTestService({BUSINESS_SERVICE_URL:PROCUREMENT_TEST_SERVICE});
  expect(fixture).toMatchObject({name:'合成采购业务服务 v1',environment:{BUSINESS_SERVICE_URL:'http://managed-procurement:8081'}});
  expect(managedMigrationTestService({BUSINESS_SERVICE_URL:'https://user.example/api'})).toMatchObject({egress:true,environment:{BUSINESS_SERVICE_URL:'http://managed-service-relay:8081'}});
  expect(()=>managedMigrationTestService({BUSINESS_SERVICE_URL:'http://user.example'})).toThrow('HTTPS');
  expect(()=>managedMigrationTestService({BUSINESS_SERVICE_URL:'https://127.0.0.1'})).toThrow('私网');
  expect(()=>managedMigrationTestService({BUSINESS_SERVICE_URL:PROCUREMENT_TEST_SERVICE,OTHER:'value'})).toThrow('一次只允许');
});
