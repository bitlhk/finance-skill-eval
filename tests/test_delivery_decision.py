import unittest

from improvement.delivery import execute


class DeliveryDecisionTests(unittest.TestCase):
    def setUp(self):
        self.request={'basic':{'approved':True,'coversTaskScope':True},
                      'effect':{'evidenceStatus':'CHECKED','selected':True,'targetPassRate':0.5,
                                'measuredPassRate':0.5,'targetReached':True},
                      'holdout':{'caseIds':['a','b'],'runs':[
                          [{'id':'a','passed':True},{'id':'b','passed':False}],
                          [{'id':'a','passed':True},{'id':'b','passed':False}]]}}

    def test_selected_target_and_repetitions(self):
        self.assertEqual(execute(self.request),{'approved':True,'rates':{'target':0.5,'development':0.5,'holdout':0.5}})
        self.request['effect']['targetPassRate']=0.75
        self.assertFalse(execute(self.request)['approved'])

    def test_missing_or_unverified_evidence_never_counts_as_pass(self):
        for bad in ({'id':'a','passed':True,'unverified':True},{'id':'a','passed':True,'failureStage':'JUDGE'},
                    {'id':'a','passed':None},{'id':'b','passed':True}):
            request={**self.request,'holdout':{'caseIds':['a','b'],'runs':[[bad,{'id':'b','passed':False}]]}}
            self.assertFalse(execute(request)['approved'])
        self.assertFalse(execute({**self.request,'basic':{'approved':True,'coversTaskScope':False}})['approved'])
        self.assertFalse(execute({**self.request,'effect':{**self.request['effect'],'selected':False}})['approved'])

    def test_unspecified_rate_uses_review_and_does_not_ignore_unreviewed_holdout_failures(self):
        effect={**self.request['effect'],'targetPassRate':None,'measuredPassRate':0.5,'targetReached':None}
        self.assertFalse(execute({**self.request,'effect':effect})['approved'])
        self.assertEqual(execute({**self.request,'effect':effect,'holdout':None}),
            {'approved':True,'rates':{'target':None,'development':0.5,'holdout':None}})
