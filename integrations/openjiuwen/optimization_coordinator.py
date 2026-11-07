"""Evidence-bound optimization capabilities for an OpenJiuwen coordinator.

The model chooses which capability to invoke. This object only checks the
dependencies and guarantees that unreviewed candidates cannot be adopted.
"""
from datetime import datetime, timezone
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))
from improvement.policy import comparable, select


def now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def evaluation_summary(evaluation):
    return {'id': evaluation['id'], 'candidate': evaluation['candidate'],
            'cases': [{'id': case['id'], 'passed': case['passed']} for case in evaluation['cases']]}


class OptimizationCoordinator:
    def __init__(self, state, baseline, invoke, resume=None, build_available=False):
        self.state, self.baseline, self.invoke = state, baseline, invoke
        self.resume = resume
        self.best = (resume or {}).get('incumbent', baseline)
        self.working = (resume or {}).get('working', baseline)
        self.round = state['rounds'][-1] if resume and state['rounds'] else None
        self.phase = (resume or {}).get('phase', 'EVALUATION') if resume else 'DIAGNOSIS'
        self.candidate = (resume or {}).get('candidate')
        self.evaluation = None
        self.terminal = False
        self.build_available = build_available

    async def save(self):
        await self.invoke('save', {'state': self.state})

    async def stage(self, value):
        self.state['stage'] = value
        self.round['stage'] = value
        await self.save()

    async def initialize(self):
        if not comparable(self.baseline, self.baseline):
            raise ValueError('基线评测未完整完成，不能进入优化')
        ids = {case['id'] for case in self.baseline['cases']}
        if any(item not in ids for item in self.state['goal'].get('protectedCaseIds', [])):
            raise ValueError('必须通过的案例不属于本次开发集')
        if self.resume and (not self.state.get('waiting') or not self.round):
            raise ValueError('没有可恢复的等待轮次')
        if self.resume and self.phase not in ('ADJUSTMENT', 'EVALUATION'):
            raise ValueError('不支持从该优化阶段恢复')
        if self.resume and self.phase == 'ADJUSTMENT':
            if self.state['waiting'].get('kind') != 'INPUT' or self.round.get('stage') != 'ADJUSTMENT' or not self.round.get('diagnosis'):
                raise ValueError('没有可恢复的调整提问')
            if self.state['waiting'].get('candidate') != self.working['candidate']:
                raise ValueError('待恢复的调整与工作版本不匹配')
        self.state.setdefault('baselineEvaluationId', self.baseline['id'])
        self.state['working'], self.state['workingEvaluationId'] = self.working['candidate'], self.working['id']
        if self.resume:
            if self.phase == 'EVALUATION':
                self.round['candidate'] = self.candidate
            self.state['status'] = 'RUNNING'
            self.state.pop('reason', None)
            self.state.pop('waiting', None)
        await self.save()

    async def call(self, name, payload):
        response = await self.invoke(name, {'round': self.round, **payload})
        if response.get('compositions'):
            self.round.setdefault('compositions', []).extend(response['compositions'])
        if response.get('investigation') is not None:
            self.round['investigation'] = response['investigation']
        return response.get('value')

    async def finish(self, reason=None):
        if self.terminal:
            return {'status': self.state['status'], 'reason': self.state.get('reason')}
        improved = self.state['bestEvaluationId'] != self.state['baselineEvaluationId']
        self.state['status'] = 'REVIEW' if improved else 'STOPPED'
        self.state['reason'] = reason or ('已保留审查认可的候选，等待人工选择' if improved else '优化结束，保留已审查的基线')
        self.state['finishedAt'] = now()
        self.terminal = True
        await self.invoke('activate', {'evaluation': self.best})
        await self.save()
        return {'status': self.state['status'], 'reason': self.state['reason']}

    async def diagnose(self):
        if self.terminal or self.phase != 'DIAGNOSIS':
            return {'accepted': False, 'reason': '请先完成当前候选的评测和审查'}
        pending = self.round and self.round.get('stage') == 'DIAGNOSIS' and not self.round.get('diagnosis')
        if not pending and len(self.state['rounds']) >= self.state['goal']['maxRounds']:
            reason = ('已用完优化轮次；实验版本及待修复问题已保存，最终推荐仍为此前审查认可的版本'
                      if self.working['id'] != self.best['id'] else '已用完优化轮次；保留已审查的推荐版本')
            return await self.finish(reason)
        # A transient diagnosis/tool failure has not produced an experiment.
        # Retrying it continues the pending round instead of spending another.
        if not pending:
            self.round = {'number': len(self.state['rounds']) + 1, 'baseline': self.working['candidate'], 'stage': 'DIAGNOSIS'}
            self.state['rounds'].append(self.round)
        await self.stage('DIAGNOSIS')
        diagnosis = await self.call('diagnose', {'baseline': self.working, 'history': self.state['rounds'][:-1]})
        self.round['diagnosis'] = diagnosis
        if diagnosis['status'] == 'ABSTAINED':
            return await self.finish(diagnosis['reason'])
        self.phase = 'ADJUSTMENT'
        await self.save()
        return {'accepted': True, 'diagnosis': diagnosis}

    async def adjust(self):
        if self.terminal or self.phase != 'ADJUSTMENT':
            return {'accepted': False, 'reason': '请先完成当前轮次的诊断'}
        await self.stage('ADJUSTMENT')
        adjustment = await self.call('adjust', {'baseline': self.working['candidate'], 'diagnosis': self.round['diagnosis']})
        if isinstance(adjustment, dict) and adjustment.get('status') == 'WAITING':
            deadline_value = self.state.get('deadlineAt')
            deadline = datetime.fromisoformat(deadline_value.replace('Z', '+00:00')) if deadline_value else None
            self.state['waiting'] = {'kind': adjustment['kind'], 'candidate': adjustment['candidate'], 'reason': adjustment['reason'],
                                     'since': now(), **({'remainingMs': max(0, int((deadline - datetime.now(timezone.utc)).total_seconds() * 1000))} if deadline else {})}
            self.round.update(candidate=adjustment['candidate'], reason=adjustment['reason'])
            self.state.update(status='WAITING', reason=adjustment['reason'])
            self.state.pop('finishedAt', None)
            if adjustment['kind'] == 'BUILDER' and self.build_available:
                self.phase = 'BUILDER'
                await self.save()
                return {'accepted': True, 'status': 'BUILDER_REQUIRED', 'reason': adjustment['reason']}
            self.terminal = True
            await self.save()
            return {'status': 'WAITING', 'reason': adjustment['reason']}
        if not adjustment:
            return await self.finish('当前入口不具备该诊断所需的调整能力；请在工程迁移任务中继续')
        self.candidate = adjustment
        self.round['candidate'] = adjustment
        if adjustment['digest'] == self.working['candidate']['digest']:
            self.round.update(selected=False, reason='候选没有有效变化')
            self.phase = 'DIAGNOSIS'
            await self.save()
            return {'accepted': False, 'reason': '候选没有有效变化，可重新诊断'}
        self.phase = 'EVALUATION'
        await self.save()
        return {'accepted': True, 'candidate': adjustment}

    async def build_runtime(self):
        if self.terminal or self.phase != 'BUILDER' or not self.state.get('waiting'):
            return {'accepted': False, 'reason': '当前没有待构建的 Runtime'}
        waiting = self.state['waiting']
        result = await self.call('build_runtime', {'waiting': waiting, 'diagnosis': self.round['diagnosis']})
        if isinstance(result, dict) and result.get('requestId'):
            waiting['requestId'] = result['requestId']
        if not isinstance(result, dict) or result.get('status') != 'READY':
            reason = result.get('reason', '构建未完成，需要处理外部条件') if isinstance(result, dict) else '构建未返回有效结果'
            waiting['reason'] = reason
            self.state.update(status='WAITING', reason=reason)
            self.round['reason'] = reason
            self.terminal = True
            await self.save()
            return {'status': 'WAITING', 'reason': reason}
        if result.get('candidate') != waiting['candidate'] or not result.get('reference'):
            raise ValueError('Builder 交付与本轮候选不匹配')
        self.candidate = waiting['candidate']
        self.resume = {'contextChange': {'reference': result['reference'], 'reason': waiting['reason']}}
        self.round['candidate'] = self.candidate
        self.state['status'] = 'RUNNING'
        self.state.pop('waiting', None)
        self.state.pop('reason', None)
        self.phase = 'EVALUATION'
        await self.save()
        return {'accepted': True, 'candidate': self.candidate, 'reference': result['reference']}

    async def evaluate(self):
        if self.terminal or self.phase != 'EVALUATION':
            return {'accepted': False, 'reason': '没有待复测的候选'}
        await self.stage('EVALUATION')
        evaluated = await self.call('evaluate', {'candidate': self.candidate})
        self.round['evaluationId'] = evaluated['id']
        if evaluated['candidate'] != self.candidate:
            raise ValueError('复测结果不属于本轮候选')
        if self.resume and self.working['protocolDigest'] != evaluated['protocolDigest']:
            if not self.working.get('criteriaDigest') or self.working['criteriaDigest'] != evaluated.get('criteriaDigest'):
                raise ValueError('恢复后评测标准发生变化，不能沿用原优化目标')
            self.state.setdefault('contextChanges', []).append({'beforeProtocolDigest': self.working['protocolDigest'],
                'afterProtocolDigest': evaluated['protocolDigest'], 'criteriaDigest': self.working['criteriaDigest'], **self.resume['contextChange']})
        changes = self.state.get('contextChanges', [])
        if not comparable(self.working, evaluated, changes) or not comparable(self.best, evaluated, changes):
            raise ValueError('评测未完成或条件发生变化，不能判断改进')
        self.evaluation = evaluated
        self.phase = 'REVIEW'
        await self.save()
        return {'accepted': True, 'evaluation': evaluation_summary(evaluated)}

    async def review(self):
        if self.terminal or self.phase != 'REVIEW':
            return {'accepted': False, 'reason': '请先取得本轮可比的评测结果'}
        await self.stage('REVIEW')
        reviewed = await self.call('review', {'before': self.working, 'after': self.evaluation, 'incumbent': self.best})
        self.round['review'] = reviewed
        await self.stage('SELECTION')
        decision = select(self.working, self.evaluation, self.best, reviewed,
                          self.state['goal'].get('protectedCaseIds', []), self.state.get('contextChanges', []))
        self.round.update(decision)
        if decision['selected']:
            self.best = self.evaluation
            self.state['best'], self.state['bestEvaluationId'] = self.best['candidate'], self.best['id']
        self.working = self.evaluation if decision['selected'] or decision['continued'] else self.best
        self.state['working'], self.state['workingEvaluationId'] = self.working['candidate'], self.working['id']
        self.state['targetReached'] = decision['selected'] and (sum(case['passed'] is True for case in self.best['cases']) /
                                     len(self.best['cases']) >= self.state['goal']['targetPassRate'])
        await self.invoke('activate', {'evaluation': self.working})
        self.phase, self.resume = 'DIAGNOSIS', None
        await self.save()
        if self.state['targetReached']:
            await self.finish('达到目标且独立审查通过，等待人工选择')
        return {'accepted': True, 'review': reviewed, 'decision': decision,
                'targetReached': self.state['targetReached'], 'remainingRounds': self.state['goal']['maxRounds'] - len(self.state['rounds'])}
