import {it,expect} from 'vitest';
import {migrationDeliveryStatus} from '../src/migration/domain/migration-delivery-status.js';
const complete={targetExecution:'PASSED',reuseDesign:'REVIEWED',reuseAcceptance:'PASSED',technicalReady:true};
it('requires all separate evidence gates, not business success alone',()=>{
 expect(migrationDeliveryStatus(complete)).toEqual({status:'VERIFIED',gaps:[]});
 for(const input of [{...complete,reuseAcceptance:'NOT_RUN'},{...complete,reuseDesign:'NOT_REVIEWED'},
  {...complete,targetExecution:'NOT_RUN'},{...complete,technicalReady:false}])expect(migrationDeliveryStatus(input).status).toBe('UNVERIFIED');
});
it.each(['STALE','FAILED','RUNNING','INDETERMINATE','CANCELLED','INTERRUPTED'])('never marks %s reuse evidence verified',status=>{
 expect(migrationDeliveryStatus({...complete,reuseAcceptance:status})).toMatchObject({status:'UNVERIFIED'});
});
