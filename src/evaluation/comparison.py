"""Fixed pairwise evaluation sequence; runtime and judge calls remain ports."""
from tasks.application_host import call, dispatch, CapabilityError, run_program
from evaluation.evidence import execute as answer_evidence
from evaluation.evidence import resources
from evaluation.orchestration import evaluate_methods, planned_methods
from tasks.values import now
from uuid import uuid4


async def evaluate(eval_case, left, right, judge, *, independent=False, methods=None, script_executor=None):
    """Native entry for both fixed comparison and saved-evidence rescoring.

    Business execution stays with the caller; judges cannot silently rerun it.
    Both sides use the same method plan, then the existing fixed program decides
    whether judging is applicable and assembles the unchanged report structure.
    """
    selected = methods if methods is not None else planned_methods(eval_case.get('evaluationPlan'), script_executor)
    body = {'evalCase': eval_case, 'left': left, 'right': right, 'hasMethods': bool(selected),
            'independent': independent, 'resources': {'left': resources(left), 'right': resources(right)}}
    async def assess(inputs):
        return await evaluate_methods(eval_case, body[inputs['side']], selected)
    async def judge_case(_):
        # The Judge receives frozen copies, not writable business state.
        from copy import deepcopy
        return await judge(deepcopy({'evalCase': eval_case, 'left': left, 'right': right}))
    return await run_program(run(body), {'methods': assess, 'judge': judge_case})


def execute(request):
    body, progress = request['body'], request['progress']
    case, left, right = body['evalCase'], body['left'], body['right']
    if request['action'] == 'next':
        if body['hasMethods']:
            for side in ('left', 'right'):
                if side not in progress['methodResults']:
                    return {'kind': 'methods', 'side': side}
        if not progress['judgeDone']:
            if not body['independent'] and (left['status'] != 'completed' or right['status'] != 'completed'):
                return {'kind': 'skipJudge', 'reason': '执行未完成，不计入专业质量评分；请修复运行环境后重测。'}
            return {'kind': 'judge'}
        return {'kind': 'done'}
    if request['action'] != 'finish':
        raise ValueError('Unknown comparison action')
    report = {'caseId': case['caseId'], 'name': case['name'], 'prompt': case['prompt'],
              'evaluationGoal': case['evaluationGoal'],
              'answerEvidence': {side: answer_evidence({'resources': body['resources'][side], 'plan': case.get('evaluationPlan')})
                                 for side in ('left', 'right')},
              'left': left, 'right': right, 'judge': progress['judge'], 'judgeError': progress['judgeError']}
    if body['hasMethods']:
        report['methodResults'] = progress['methodResults']
    return report


def run(body):
    """A fixed comparison program, shared by live evaluation and rescoring."""
    progress = {'methodResults': {}, 'judgeDone': False, 'judge': None, 'judgeError': None}
    while True:
        next_ = execute({'action': 'next', 'body': body, 'progress': progress})
        if next_['kind'] == 'done':
            return execute({'action': 'finish', 'body': body, 'progress': progress})
        if next_['kind'] == 'methods':
            progress['methodResults'][next_['side']] = yield call('methods', {'side': next_['side']})
            continue
        progress['judgeDone'] = True
        if next_['kind'] == 'skipJudge':
            progress['judgeError'] = next_['reason']
            continue
        try:
            progress['judge'] = yield call('judge')
        except CapabilityError as error:
            if error.detail.get('aborted') or error.detail.get('name') == 'EvaluationCancelledError':
                raise
            progress['judgeError'] = str(error)


def execute_program(request):
    return dispatch(request, {'run': run, 'suite': run_suite})


def run_suite(request):
    """One fixed evaluation run, including mandatory cleanup and its receipt.

    The execution adapter can run cases concurrently. It must return both sides
    of every frozen case before judging begins; an incomplete adapter result
    never turns into a successful report. Cleanup is attempted exactly once,
    including after prepare failure or cancellation.
    """
    run_id = request.get('runId') or 'finance-skill-eval-' + str(uuid4())
    pack = request['pack']
    completed, total, cleanup_requested = 0, len(pack['cases']) * 2, False

    def progress(stage):
        return call('progress', {'stage': stage, 'completedRuns': completed, 'totalRuns': total})

    try:
        yield progress('preparing')
        yield call('prepare', {'runId': run_id})
        evidence = yield call('execute_cases', {'runId': run_id})
        completed = sum(len(sides) for sides in evidence.values())
        cleanup_requested = True
        yield call('cleanup', cleanup=True)
        yield progress('judging')
        cases = []
        for case in pack['cases']:
            sides = evidence.get(case['caseId'], {})
            if not sides.get('left') or not sides.get('right'):
                raise ValueError('Runtime did not produce both sides for ' + case['caseId'])
            cases.append((yield call('evaluate_case', {'evalCase': case, 'left': sides['left'], 'right': sides['right']})))
        report = yield call('report', {'reportId': run_id, 'cases': cases})
        yield progress('completed')
        return report
    finally:
        try:
            if not cleanup_requested:
                yield call('cleanup', cleanup=True)
        finally:
            yield call('finalization', {'runId': run_id, 'observedAt': now()}, cleanup=True)


async def evaluate_suite(pack, handlers, *, run_id=None):
    """Native service entry using the same lifecycle as the transition adapter."""
    return await run_program(run_suite({'pack': pack, **({'runId': run_id} if run_id else {})}), handlers)
