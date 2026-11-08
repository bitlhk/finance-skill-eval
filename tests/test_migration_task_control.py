from copy import deepcopy
import unittest

from migration.control import execute, MigrationControlError


def task():
    return {'id':'bundle-ab','goal':'提高正确率','inputKind':'skill_package','currentCandidateId':'candidate-new',
            'configuration':{'modelId':'model'},'suite':{'cases':[]},'candidates':[{'id':'candidate-new','digest':'new'}],
            'attempts':[],'runs':[]}


def current():
    return {'id':'attempt-ab','kind':'CHAT','key':'request','requestDigest':'digest','baseCandidateId':'candidate-new',
            'status':'RUNNING','startedAt':'2026-01-01T00:00:00.000Z','agentRunId':'agent-ab',
            'sessionExecutionId':'execution-ab','sessionInputDigest':'input'}


def evaluation(ident, digest, outcomes):
    return {'id':ident,'candidate':{'id':'candidate-'+digest,'digest':digest},'protocolDigest':'same',
            'cases':[{'id':str(index),'passed':passed,'observation':{}} for index,passed in enumerate(outcomes)]}


def loop():
    return {'id':'loop','goal':{'goal':'提高正确率','maxRounds':2,'targetPassRate':1},
            'baseline':{'id':'candidate-old','digest':'old'},'best':{'id':'candidate-old','digest':'old'},
            'working':{'id':'candidate-old','digest':'old'},'bestEvaluationId':'baseline','workingEvaluationId':'baseline',
            'baselineEvaluationId':'baseline','status':'RUNNING','stage':'ADJUSTMENT','rounds':[]}


class MigrationTaskControlTests(unittest.TestCase):
    def call(self, value, action, inputs=None, ident='attempt-ab'):
        return execute({'task':value,'action':action,'attemptId':ident,'inputs':inputs or {}})

    def test_registration_is_idempotent_and_does_not_mutate_input(self):
        value=task();original=deepcopy(value)
        inputs={'kind':'CHAT','input':{'key':'one','baseCandidateId':'candidate-new','phase':'development'},
                'requestDigest':'hash','persisted':True,'facts':{'inputDigest':'input'}}
        first=self.call(value,'register',inputs)
        self.assertEqual(value,original)
        self.assertFalse(first['value']['duplicate'])
        second=self.call(first['task'],'register',inputs)
        self.assertTrue(second['value']['duplicate'])
        self.assertEqual(len(second['task']['attempts']),1)
        with self.assertRaises(MigrationControlError):
            self.call(first['task'],'register',{**inputs,'requestDigest':'different'})

    def test_waiting_requires_real_question_and_resumes_same_attempt(self):
        value=task();value['attempts']=[current()]
        with self.assertRaises(MigrationControlError):
            self.call(value,'waiting',{'interactions':[{}]})
        waiting=self.call(value,'waiting',{'interactions':[{'interaction_id':'question'}]})['task']
        restored=self.call(waiting,'register',{'kind':'CHAT','input':{
            'key':'answer','baseCandidateId':'candidate-new','resumeAttemptId':'attempt-ab',
            'sessionAnswer':{'interactionId':'question','answers':{'范围':'保留工具'}}},
            'requestDigest':'answer-hash','facts':{'inputDigest':'input'}})
        self.assertEqual(restored['value']['attemptId'],'attempt-ab')
        self.assertEqual(restored['task']['attempts'][0]['status'],'RUNNING')
        self.assertEqual(len(restored['task']['attempts']),1)

    def test_close_remains_recoverable_and_user_cancel_is_terminal(self):
        value=task();value['attempts']=[current()]
        for closing, expected in ((True,'INTERRUPTED'),(False,'CANCELLED')):
            result=self.call(value,'failed',{'aborted':True,'closing':closing})
            self.assertEqual(result['task']['attempts'][0]['status'],expected)

    def test_unconfirmed_answer_stays_waiting(self):
        value=task();value['attempts']=[{**current(),'sessionAnswer':{'interactionId':'q','answers':{'q':'a'}}}]
        result=self.call(value,'failed',{'retryInteraction':True,'error':'not delivered'})
        self.assertEqual(result['task']['attempts'][0]['status'],'WAITING')
        self.assertNotIn('sessionAnswer',result['task']['attempts'][0])

    def test_evaluation_retry_uses_existing_round(self):
        value=task();a=current();a['optimization']=loop();value['attempts']=[a]
        inputs={'optimizationOwnerId':'attempt-ab','candidateDigest':'new','optimizationInputs':{}}
        started=self.call(value,'evaluation_requested',inputs)['task']
        self.assertEqual(len(started['attempts'][0]['optimization']['rounds']),1)
        started['attempts'][0]['agentResumeEvaluation']=True
        retried=self.call(started,'evaluation_requested',inputs)['task']
        self.assertEqual(len(retried['attempts'][0]['optimization']['rounds']),1)

    def test_exhausted_budget_stops_before_evaluation(self):
        value=task();a=current();a['optimization']=loop();a['optimization']['goal']['maxRounds']=0;value['attempts']=[a]
        with self.assertRaises(MigrationControlError):
            self.call(value,'evaluation_requested',{'optimizationOwnerId':a['id'],'candidateDigest':'new'})

    def test_single_evaluation_followup_can_retest_but_still_checks_readiness(self):
        value=task();a=current();a['agentFollowup']=True;value['attempts']=[a]
        result=self.call(value,'evaluation_requested',{'candidateDigest':'new'})
        self.assertEqual(result['value']['next'],'evaluate')
        self.assertIsNone(result['value']['optimizationOwnerId'])
        self.assertNotIn('optimization',result['task']['attempts'][0])
        with self.assertRaises(MigrationControlError):
            self.call(value,'evaluation_requested',{'evaluationIssues':['Runtime unavailable']})

    def test_evaluation_completion_continues_main_session_without_exposing_holdout(self):
        value=task();a=current();value['attempts']=[a]
        result=self.call(value,'evaluation_completed',{'run':{'id':'run','status':'PASSED'},'persisted':True,'inputDigest':'input'})
        parent,child=result['task']['attempts']
        self.assertEqual(parent['status'],'COMPLETED')
        self.assertTrue(child['agentFollowup']);self.assertTrue(child['agentCanReview'])
        self.assertEqual(child['sessionInputDigest'],'input')
        self.assertEqual(result['value']['attemptId'],child['id'])

    def review(self, recommendation, max_rounds=2, outcomes=(True,True)):
        value=task();root=current();root['optimization']=loop();root['optimization']['stage']='REVIEW'
        root['optimization']['goal']['maxRounds']=max_rounds
        root['optimization']['rounds']=[{'number':1,'stage':'REVIEW','candidate':{'id':'candidate-new','digest':'new'}}]
        child={**current(),'id':'attempt-review','agentOptimizationOwnerId':'attempt-ab'}
        value['attempts']=[root,child]
        review={'status':'PRODUCED','review':{'recommendation':recommendation,'reason':'证据支持',
                'improvements':['提高'],'regressions':[],'evidenceIds':['0'],'nextFocus':['修复剩余案例']}}
        return self.call(value,'review_completed',{'baseline':evaluation('baseline','old',(False,False)),
            'incumbent':evaluation('baseline','old',(False,False)),'evaluated':evaluation('new','new',outcomes),
            'review':review,'scopeDigest':'scope','evidence':[{'evidenceId':'0','completed':True,'comparable':True}],
            'persisted':True,'inputDigest':'input'},ident='attempt-review')

    def test_review_recommendation_and_goal_end_the_loop(self):
        result=self.review('KEEP_CANDIDATE')
        state=result['task']['attempts'][0]['optimization']
        self.assertTrue(state['targetReached']);self.assertEqual(state['status'],'REVIEW')
        self.assertEqual(state['bestEvaluationId'],'new')

    def test_review_can_continue_work_without_promoting_recommended_version(self):
        result=self.review('CONTINUE_CANDIDATE',outcomes=(True,False))
        state=result['task']['attempts'][0]['optimization']
        self.assertEqual(state['bestEvaluationId'],'baseline')
        self.assertEqual(state['workingEvaluationId'],'new')
        self.assertEqual(state['stage'],'ADJUSTMENT')
        self.assertFalse(state['targetReached'])

    def test_budget_exhaustion_preserves_reviewed_work(self):
        state=self.review('CONTINUE_CANDIDATE',max_rounds=1,outcomes=(True,False))['task']['attempts'][0]['optimization']
        self.assertEqual(state['status'],'REVIEW');self.assertEqual(state['workingEvaluationId'],'new')

    def test_inconclusive_review_cannot_advance_to_another_adjustment(self):
        state=self.review('INCONCLUSIVE')['task']['attempts'][0]['optimization']
        self.assertEqual(state['status'],'INTERRUPTED');self.assertEqual(state['rounds'][0]['stage'],'REVIEW')

    def test_takeover_preserves_attempt_and_changes_only_execution_identity(self):
        value=task();a=current();a['status']='INTERRUPTED';value['attempts']=[a]
        result=self.call(value,'recover',{'inputDigest':'input','executionId':'execution-ab',
            'status':{'available':False,'state':'interrupted'},'round':{'status':'running','recoverable':True}})
        restored=result['task']['attempts'][0]
        self.assertEqual(restored['id'],a['id']);self.assertEqual(restored['agentRunId'],a['agentRunId'])
        self.assertNotEqual(restored['sessionExecutionId'],a['sessionExecutionId'])
        self.assertTrue(restored['sessionRecoverCheckpoint'])

    def test_paused_and_confirmed_failed_executions_are_not_auto_replayed(self):
        value=task();value['attempts']=[current()]
        for extra in ({'paused':{'status':'paused'}},{'status':{'available':False,'state':'failed'}}):
            result=self.call(value,'recover',{'inputDigest':'input','executionId':'execution-ab',
                'status':{'available':False,'state':'interrupted'},'round':{'status':'running','recoverable':True},**extra})
            self.assertEqual(result['value']['next'],'done')

    def test_pause_ack_saves_scope_and_resume_releases_control_state(self):
        value=task();value['attempts']=[current()]
        requested=self.call(value,'control_requested',{'action':'pause'})
        self.assertEqual(requested['value'],'attempt-ab')
        self.assertEqual(requested['task']['attempts'][0]['sessionControl']['status'],'PAUSING')
        with self.assertRaises(MigrationControlError):
            self.call(requested['task'],'control_requested',{'action':'pause'})
        paused=self.call(requested['task'],'control_ack',{'accepted':True,'action':'pause','inputDigest':'paused-input'})['task']
        self.assertEqual(paused['attempts'][0]['sessionControl']['status'],'PAUSED')
        self.assertEqual(paused['attempts'][0]['sessionInputDigest'],'paused-input')
        pending=self.call(paused,'control_requested',{'action':'resume'})['task']
        failed=self.call(pending,'control_not_sent',{'action':'resume'})['task']
        self.assertEqual(failed['attempts'][0]['sessionControl']['status'],'PAUSED')
        resumed=self.call(pending,'control_ack',{'accepted':True,'action':'resume'})['task']
        self.assertNotIn('sessionControl',resumed['attempts'][0])

    def test_unreachable_control_is_not_proof_of_safe_recovery(self):
        value=task();value['attempts']=[{**current(),'status':'INTERRUPTED','sessionControl':{'status':'UNKNOWN'}}]
        result=self.call(value,'reconcile_control',{'state':'UNAVAILABLE','verified':False,
            'available':False,'inputDigest':'input','round':{'status':'running','recoverable':True}})
        self.assertEqual(result['task']['attempts'][0]['sessionControl']['status'],'UNKNOWN')

    def test_runtime_preparation_keeps_rebuild_as_explicit_limitation(self):
        value=task();value['attempts']=[current()]
        value['selectedRuntimeBuildRequestId']='build'
        value['runtimeBuildRequests']=[{'requirements':{'requestId':'build','rebuild':{'baseline':{}}}}]
        # A present rebuild contract is an explicit request even if its contents are incomplete.
        value['runtimeBuildRequests'][0]['requirements']['rebuild']={'baseline':{'id':'old'}}
        with self.assertRaisesRegex(MigrationControlError,'重建接口'):
            self.call(value,'runtime_requested',{'requestId':'build','builderAvailable':True,'reason':'missing capability'})

    def test_startup_keeps_waiting_questions_and_preserves_finished_runs(self):
        value=task();a=current();a.update(status='WAITING',waitingInteractionIds=['q']);value['attempts']=[a]
        value['runs']=[{'id':'done','status':'PASSED'}]
        result=self.call(value,'startup',{'inputDigest':'input'})
        self.assertFalse(result['value']['changed'])
        self.assertEqual(result['task']['attempts'][0]['status'],'WAITING')
        self.assertEqual(result['task']['runs'][0]['status'],'PASSED')

    def test_review_cannot_compare_holdout_or_different_workspace(self):
        value=task();value['attempts']=[current()]
        value['runs']=[{'id':'baseline','phase':'development'},
                       {'id':'new','phase':'holdout','candidateId':'candidate-new','candidateDigest':'new'}]
        with self.assertRaises(MigrationControlError):
            self.call(value,'review_requested',{'request':{'baselineRunId':'baseline','candidateRunId':'new'}})

    def test_manual_recovery_and_pause_are_not_automatic_takeover_candidates(self):
        for status in ('PAUSED', 'RECOVERABLE'):
            value=task();value['attempts']=[{**current(),'status':'INTERRUPTED','sessionControl':{'status':status}}]
            self.assertFalse(self.call(value,'recovery_eligible',{'inputDigest':'input'})['value'])

    def test_goal_change_stops_old_budget_and_ignores_late_execution_writes(self):
        value=task();a=current();a.update(status='WAITING',optimization=loop());value['attempts']=[a]
        result=self.call(value,'goal_events',{'events':[{'sequence':1,'createdAt':'2026-01-01T00:01:00Z',
            'payload':{'goal':'保留原能力','attemptId':a['id']}}]})['task']
        self.assertEqual(result['goal'],'保留原能力')
        self.assertEqual(result['attempts'][0]['optimization']['status'],'STOPPED')
        self.assertEqual(result['attempts'][0]['status'],'INTERRUPTED')
        result['attempts'][0]['finishedAt']='2026-01-01T00:02:00Z'
        late=self.call(result,'goal_events',{'events':[{'sequence':2,'createdAt':'2026-01-01T00:03:00Z',
            'payload':{'goal':'过期写入','attemptId':a['id']}}]})['task']
        self.assertEqual(late['goal'],'保留原能力');self.assertEqual(late['goalEventSequence'],2)

    def test_external_configuration_wait_resumes_original_round_in_main_session(self):
        value=task();value['currentCandidateId']='candidate-old'
        a=current();a.update(kind='OPTIMIZE',status='WAITING',optimization=loop(),
            optimizationInputs={'planDigest':'plan','judgeDigest':'judge'})
        a['optimization'].update(status='WAITING',waiting={'kind':'CONFIGURATION','reason':'调整超时',
            'candidate':{'id':'candidate-new','digest':'new'},'remainingMs':2000},rounds=[{'number':1,'stage':'ADJUSTMENT'}])
        value['attempts']=[a];value['runs']=[{'id':'baseline','configurationDigest':'old-config'}]
        facts={'frozenSuites':{a['id']:True},'planDigest':'plan','judgeDigest':'judge',
               'configurationDigest':'new-config','runs':{'baseline':{'suiteMatches':True}}}
        result=self.call(value,'external_resume',{'facts':facts})['task']
        resumed=result['attempts'][0]
        self.assertEqual(resumed['kind'],'CHAT');self.assertEqual(resumed['optimization']['status'],'INTERRUPTED')
        self.assertEqual(resumed['optimization']['rounds'][0]['candidate']['id'],'candidate-new')
        self.assertEqual(result['currentCandidateId'],'candidate-new')
        self.assertNotIn('waiting',resumed['optimization'])
        facts['judgeDigest']='changed'
        with self.assertRaises(MigrationControlError):
            self.call(value,'external_resume',{'facts':facts})
        self.assertEqual(value['attempts'][0]['status'],'WAITING')

    def test_cancel_wait_retains_history_and_restores_evaluated_runtime(self):
        value=task();a=current();a.update(kind='OPTIMIZE',status='WAITING',optimization=loop())
        a['optimization'].update(status='WAITING',waiting={'kind':'CONFIGURATION'})
        value['attempts']=[a];value['runs']=[{'id':'baseline','configuration':{'modelId':'evaluated'},'builderBindingId':'delivery'}]
        value['runtimeDeliveries']=[{'id':'delivery','requestId':'build'}]
        result=self.call(value,'cancel_waiting')['task']
        self.assertEqual(result['attempts'][0]['status'],'CANCELLED')
        self.assertEqual(result['configuration']['modelId'],'evaluated')
        self.assertEqual(result['selectedRuntimeBuildRequestId'],'build')
        self.assertEqual(len(result['runs']),1)
