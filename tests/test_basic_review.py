import unittest

from improvement.basic_review import validate


class BasicReviewTests(unittest.TestCase):
    def test_current_successful_evidence_and_failures(self):
        digest='a'*64
        review={'status':'SUFFICIENT','scope':'启动检查','reason':'命令正常退出',
                'references':[{'kind':'project_check','id':'check'}]}
        checks=[{'receiptId':'check','snapshotDigest':digest,'status':'COMPLETED','exitCode':0}]
        self.assertTrue(validate(review,digest,checks,[])['valid'])
        self.assertTrue(validate({**review,'coversTaskScope':True},digest,checks,[])['valid'])
        self.assertFalse(validate({**review,'coversTaskScope':'true'},digest,checks,[])['valid'])
        self.assertFalse(validate({**review,'status':'INCOMPLETE','coversTaskScope':True},digest,checks,[])['valid'])
        for change in ({'snapshotDigest':'b'*64},{'status':'FAILED'},{'exitCode':False}):
            self.assertFalse(validate(review,digest,[{**checks[0],**change}],[])['valid'])
        self.assertFalse(validate({**review,'references':[]},digest,checks,[])['valid'])
        self.assertFalse(validate({**review,'references':review['references']*2},digest,checks,[])['valid'])
        self.assertTrue(validate({**review,'status':'INCOMPLETE'},digest,[{**checks[0],'status':'FAILED'}],[])['valid'])

    def test_development_run_is_version_and_phase_scoped(self):
        digest='a'*64
        review={'status':'SUFFICIENT','scope':'选定案例','reason':'案例通过',
                'references':[{'kind':'development_run','id':'run'}]}
        run={'runId':'run','phase':'development','candidateDigest':digest,'status':'PASSED','matchesCurrentConfiguration':True}
        self.assertTrue(validate(review,digest,[],[run])['valid'])
        for change in ({'phase':'holdout'},{'candidateDigest':'b'*64},{'status':'FAILED'},{'matchesCurrentConfiguration':False}):
            self.assertFalse(validate(review,digest,[],[{**run,**change}])['valid'])
