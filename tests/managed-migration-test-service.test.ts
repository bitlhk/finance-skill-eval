import {expect,it} from 'vitest';
import {managedMigrationTestService,PROCUREMENT_TEST_SERVICE} from '../src/migration/infrastructure/managed-migration-test-service.js';

it('resolves the pinned procurement fixture without admitting arbitrary service URLs',()=>{
  expect(managedMigrationTestService({})).toBeNull();
  const fixture=managedMigrationTestService({BUSINESS_SERVICE_URL:PROCUREMENT_TEST_SERVICE});
  expect(fixture).toMatchObject({name:'合成采购业务服务 v1',environment:{BUSINESS_SERVICE_URL:'http://managed-procurement:8081'}});
  expect(()=>managedMigrationTestService({BUSINESS_SERVICE_URL:'https://user.example'})).toThrow('受管测试连接');
  expect(()=>managedMigrationTestService({BUSINESS_SERVICE_URL:PROCUREMENT_TEST_SERVICE,OTHER:'value'})).toThrow('受管测试连接');
});
