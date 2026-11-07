"""Freeze one read-only delivery review without changing the task workspace."""
import asyncio
import base64
import json
from pathlib import Path
import shutil
from uuid import uuid4


class DeliveryReviewSnapshots:
    def __init__(self, agent, workspace, source_files, evaluations, previous_checks=None, current_checks=None, *, delivery_query=None):
        self.agent = agent
        self.workspace = Path(workspace)
        self.source_files = source_files
        self.evaluations = evaluations
        self.previous_checks = previous_checks if isinstance(previous_checks, list) else []
        self.current_checks = current_checks if isinstance(current_checks, list) else []
        self.delivery_query = delivery_query
        self.lock = asyncio.Lock()
        self.active = {}
        self.base_prompt = next(item.system_prompt for item in agent.deep_config.subagents
                                if item.agent_card.name == 'migration_delivery_reviewer')

    async def start(self, call_id):
        if not call_id:
            raise ValueError('Review call ID is required')
        await self.lock.acquire()
        root = None
        try:
            try:
                from .agent_protocol import build_workspace
                from .bundle_agent import collect_candidate
                from .bundle_runtime import files_digest
                from .analysis_file_tools import WorkspaceReadFileTool, WorkspaceGlobTool, WorkspaceListDirTool
                from .migration_tools import build_grep_tool
                from .development_evidence import build_evaluation_evidence_tool
            except ImportError:
                from agent_protocol import build_workspace
                from bundle_agent import collect_candidate
                from bundle_runtime import files_digest
                from analysis_file_tools import WorkspaceReadFileTool, WorkspaceGlobTool, WorkspaceListDirTool
                from migration_tools import build_grep_tool
                from development_evidence import build_evaluation_evidence_tool
            from openjiuwen.core.sys_operation import SysOperation
            from openjiuwen.core.foundation.tool import LocalFunction, ToolCard
            from openjiuwen.core.sys_operation.base import OperationMode
            from openjiuwen.core.sys_operation.config import LocalWorkConfig
            from openjiuwen.core.sys_operation.sys_operation import SysOperationCard
            from openjiuwen.harness.workspace.workspace import Workspace

            candidate = await asyncio.to_thread(collect_candidate, self.workspace / 'candidate')
            task_files = await asyncio.to_thread(collect_candidate, self.workspace / 'task')
            digest = files_digest({name: base64.b64decode(value, validate=True) for name, value in candidate.items()})
            files = {prefix + name: base64.b64decode(value, validate=True)
                     for prefix, group in [('candidate/', candidate), ('source/', self.source_files), ('task/', task_files)]
                     for name, value in group.items()}
            if self.delivery_query is not None:
                files['task/delivery-tools.json'] = json.dumps(await self.delivery_query.invoke({}), ensure_ascii=False)
            root = await asyncio.to_thread(build_workspace, files)
            record = {'root':root, 'digest':digest, 'review':None}
            async def record_delivery_review(decision, summary, citations=None, issues=None, basic_review=None):
                if decision not in ('RECOMMEND', 'REVISE', 'INCONCLUSIVE') or not isinstance(summary, str) or not summary.strip() or len(summary)>4000:
                    return {'accepted':False,'reason':'审查结论或说明无效'}
                if citations is None: citations = []
                if issues is None: issues = []
                if (not isinstance(citations,list) or len(citations)>12 or not isinstance(issues,list)
                        or len(issues)>20 or any(not isinstance(item,str) or not item.strip() or len(item)>1000 for item in issues)):
                    return {'accepted':False,'reason':'审查引用或问题列表无效'}
                checked=[]
                for item in citations:
                    if not isinstance(item,dict) or set(item)!={'path','quote'}:
                        return {'accepted':False,'reason':'引用需要文件路径和原文'}
                    name,quote=item['path'],item['quote']
                    if not isinstance(name,str) or not name.startswith('candidate/') or not isinstance(quote,str) or not quote.strip() or len(quote)>1000:
                        return {'accepted':False,'reason':'引用必须指向候选文件及原文'}
                    try:
                        target=(root/name).resolve()
                        candidate_root=(root/'candidate').resolve()
                        if candidate_root not in target.parents or not target.is_file() or target.stat().st_size>1024*1024:
                            raise ValueError('invalid reference')
                        if quote not in target.read_text(encoding='utf-8'):
                            raise ValueError('quote missing')
                    except (OSError, ValueError, UnicodeError):
                        return {'accepted':False,'reason':'引用与冻结候选源码不一致'}
                    checked.append({'path':name,'quote':quote})
                if decision=='RECOMMEND' and not checked:
                    return {'accepted':False,'reason':'推荐结论需要至少一条候选源码原文引用'}
                review={'decision':decision,'summary':summary.strip(),'citations':checked,'issues':issues}
                if basic_review is not None:
                    from improvement.basic_review import validate
                    result=validate(basic_review,digest,[*self.previous_checks,*self.current_checks],self.evaluations)
                    if not result['valid']:
                        return {'accepted':False,'reason':result['reason']}
                    review['basicReview']=basic_review
                if record['review'] is not None and record['review'] != review:
                    return {'accepted':False,'reason':'本次审查已经提交，不能覆盖'}
                record['review']=review
                return {'accepted':True,'note':'已记录独立源码审查；仍须按任务范围完成基础验证和效果评测。'}

            review_tool=LocalFunction(ToolCard(id='delivery-review-record', name='record_delivery_review',
                description='提交本次独立源码审查的建议，不代表运行或验收通过。推荐时引用冻结候选内的路径和逐字原文。',
                input_params={'type':'object','properties':{
                    'decision':{'type':'string','enum':['RECOMMEND','REVISE','INCONCLUSIVE']},
                    'summary':{'type':'string'},'issues':{'type':'array','items':{'type':'string'}},
                    'basic_review':{'type':'object','properties':{
                        'status':{'type':'string','enum':['SUFFICIENT','INCOMPLETE']},
                        'scope':{'type':'string'},'reason':{'type':'string'},
                        'coversTaskScope':{'type':'boolean','description':'仅当证据足以覆盖用户选定的全部基础验证范围时为 true'},
                        'references':{'type':'array','items':{'type':'object','properties':{
                            'kind':{'type':'string','enum':['project_check','development_run']},'id':{'type':'string'}},'required':['kind','id']}}},
                        'required':['status','scope','reason','references']},
                    'citations':{'type':'array','items':{'type':'object','properties':{'path':{'type':'string'},'quote':{'type':'string'}},'required':['path','quote']}}},
                    'required':['decision','summary']}),record_delivery_review)
            operation = SysOperation(SysOperationCard(id='delivery-review-' + uuid4().hex, mode=OperationMode.LOCAL,
                work_config=LocalWorkConfig(restrict_to_sandbox=True, sandbox_root=[str(root)], shell_allowlist=[])))
            args = (operation, 'cn', 'delivery-review-' + uuid4().hex)
            read_tools = [WorkspaceReadFileTool(root, *args), WorkspaceGlobTool(root, *args),
                          WorkspaceListDirTool(root, *args), build_grep_tool(root)]
            evidence = build_evaluation_evidence_tool(self.evaluations, lambda: digest)
            async def query_project_checks():
                checks = {}
                for item in [*self.previous_checks, *self.current_checks]:
                    if isinstance(item, dict) and isinstance(item.get('receiptId'), str):
                        checks[item['receiptId']] = {**item, 'matchesReviewedWorkspace':item.get('snapshotDigest') == digest}
                return {'checks':list(checks.values())[-100:],
                    'note':'仅为实际执行回执；状态通过不自动证明全部业务能力或最终验收。'}
            checks_tool = LocalFunction(ToolCard(id='delivery-project-checks', name='query_project_checks',
                description='查看工程命令的实际执行回执，并核对是否对应本次冻结审查文件。',
                input_params={'type':'object','properties':{}}), query_project_checks)
            spec = next(item for item in self.agent.deep_config.subagents
                        if item.agent_card.name == 'migration_delivery_reviewer')
            spec.workspace = Workspace(root_path=str(root))
            spec.sys_operation = operation
            spec.tools = [*read_tools, evidence, checks_tool, review_tool]
            spec.system_prompt = (self.base_prompt + '\n本次只读冻结工作区：' + str(root)
                + '。候选文件位于 candidate/，原工程位于 source/，任务材料位于 task/；'
                  '所有文件读取必须使用此冻结工作区内的路径，不要访问交办描述中的其他绝对路径。'
                  '工具入口的实际登记记录见 task/delivery-tools.json（如存在）；它只证明登记事实，不证明运行通过。')
            self.active[call_id] = record
            return digest
        except BaseException:
            if root is not None:
                await asyncio.to_thread(shutil.rmtree, root, True)
            self.lock.release()
            raise

    async def finish(self, call_id):
        item = self.active.pop(call_id, None)
        if item is None:
            return None
        try:
            await asyncio.to_thread(shutil.rmtree, item['root'], True)
            return {'digest':item['digest'], 'review':item['review']}
        finally:
            self.lock.release()
