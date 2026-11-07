"""One code-agent workspace for all members; no judge or holdout data is mounted."""
import base64
import asyncio
import json
import hashlib
import os
from pathlib import Path
import shutil
import time
import tempfile
import re
try:
    from .agent_roles import load_bundle_role
    from .agent_protocol import build_workspace, emit, parse_structured, write_agent_dump, not_json_reason, is_output_format_failure
except ImportError:
    from agent_roles import load_bundle_role
    from agent_protocol import build_workspace, emit, parse_structured, write_agent_dump, not_json_reason, is_output_format_failure


def preparation_from_prose(result, redact):
    """Retain a completed explanation without guessing a structured inventory."""
    if not is_output_format_failure(result) or result.get('result_type') != 'answer':
        return None
    explanation = redact(str(result.get('output', '')).strip())
    return {'status': 'PRODUCED', 'preparation': {
        'summary': explanation, 'skills': [], 'entrypoints': [],
        'missing': ['工程识别结果以准备说明、会话和工作产物为准；未单独提取结构化清单。'],
        'baselinePlan': '请根据准备说明和工作产物核对运行条件，再建立实际业务基线。'}}


def preparation_answer(result, redact):
    """Only a whole response can be a structured result, never a prose example."""
    fallback = preparation_from_prose(result, redact)
    if fallback is None:
        return None
    raw = str(result.get('output', '')).strip()
    fenced = re.fullmatch(r'```(?:json)?\s*(.*?)\s*```', raw, re.S | re.I)
    try:
        value = json.loads(fenced.group(1) if fenced else raw)
    except (ValueError, TypeError):
        return fallback
    return value if isinstance(value, dict) and 'status' in value else fallback


def discussion_manifest_feedback(feedback):
    """Expose review and run identities, while detailed cases stay in the tool."""
    records = feedback.get('developmentEvaluations') or []
    result = {'developmentEvaluations': [
        {key: item.get(key) for key in ('runId', 'candidateId', 'candidateDigest', 'status')}
        for item in records if isinstance(item, dict)]}
    review = feedback.get('standardizationReview')
    if isinstance(review, dict):
        result['standardizationReview'] = review
    diagnosis = feedback.get('diagnosis')
    if isinstance(diagnosis, dict):
        result['diagnosis'] = diagnosis
    if isinstance(feedback.get('assetOmissions'), list):
        result['assetOmissions'] = feedback['assetOmissions']
    if isinstance(feedback.get('constraints'), str):
        result['constraints'] = feedback['constraints']
    return result


def collect_candidate(root):
    files = {}
    generated = {'__pycache__', '.venv', 'node_modules', '.git', '.pytest_cache', '.mypy_cache', '.ruff_cache'}
    for directory, directories, filenames in os.walk(root, followlinks=False):
        directories[:] = sorted(name for name in directories if name not in generated)
        if any((Path(directory) / name).is_symlink() for name in directories):
            raise ValueError('Candidate symlinks are not supported')
        for name in sorted(filenames):
            item = Path(directory) / name
            if item.is_symlink():
                raise ValueError('Candidate symlinks are not supported')
            if item.is_file() and item.suffix not in {'.pyc', '.pyo'}:
                files[item.relative_to(root).as_posix()] = base64.b64encode(item.read_bytes()).decode()
    return files


async def verify_delivery_contracts(candidate, registry, delivery, single_test, suite_test, redact):
    """Run each shared MCP service once while retaining a receipt for every tool."""
    tools = delivery.get('tools', [])
    services = delivery.get('services', [])
    outcomes = {}
    for service in services:
        members = [tool for tool in tools if tool.get('form') == 'MCP' and tool.get('entrypoint') in service.get('toolNames', [])]
        if not members:
            continue
        suite = await suite_test(candidate, registry, [item['toolId'] for item in members], service.get('start') or [], service.get('prepare'))
        indexed = {item.get('toolId'): item for item in suite.get('results', [])}
        for item in members:
            outcomes[item['toolId']] = indexed.get(item['toolId'], {'passed': False, 'error': suite.get('error') or '未完成该工具检查'})
    receipts = []
    for delivered in tools:
        tool_id = delivered['toolId']
        if tool_id not in outcomes:
            service = next((s for s in services if delivered['entrypoint'] in s['toolNames']), {})
            outcomes[tool_id] = await single_test(candidate, registry, tool_id,
                delivered['entrypoint'] if delivered['form'] == 'SCRIPT' else '', service.get('start'), service.get('prepare'))
        outcome = outcomes[tool_id]
        pending = outcome.get('runtimeDependenciesPending') or []
        detail = outcome.get('error') or outcome.get('note') or (
            '运行依赖待提供：' + '、'.join(pending) if pending else
            '实际独立调用完成；业务仍需验收' if outcome.get('callExecuted') else '未完成独立调用')
        receipts.append({'toolId': tool_id, 'passed': outcome.get('passed') is True,
            'callExecuted': outcome.get('callExecuted') is True, 'detail': redact(str(detail))[:1600]})
    return receipts


def bundle_contract_registry(analysis):
    registry = {}
    diagnosis = analysis.get('diagnosis') or {}
    for selection in (analysis.get('standardization') or {}).get('tools', []):
        tool = next(t for t in diagnosis['tools'] if t['id'] == selection['toolId'])
        contract = selection['contract']
        sample = contract['sampleInput']
        schema = contract['inputSchema']
        # A shared Script can dispatch multiple tools. Its wire sample explicitly
        # names the tool; the declared business parameter schema applies inside it.
        if (selection['form'] == 'SCRIPT' and isinstance(sample, dict)
                and set(sample) == {'tool', 'arguments'} and sample['tool'] == tool['name']
                and isinstance(sample['arguments'], dict)
                and not {'tool', 'arguments'}.intersection(schema.get('properties', {}))):
            schema = {'type': 'object', 'required': ['tool', 'arguments'],
                      'properties': {'tool': {'const': tool['name']}, 'arguments': schema},
                      'additionalProperties': False}
        registry[tool['id']] = {'form': selection['form'], 'language': tool['language'], 'toolName': tool['name'],
            'inputSchema': schema, 'outputSchema': contract['outputSchema'], 'strictContract': True,
            'scriptConfigurationMode': 'ENVIRONMENT',
            **({'sampleInput': sample} if sample is not None else {'sampleMissing': contract['sampleReason']}),
            'dependencies': [d for d in diagnosis.get('dependencies', []) if tool['id'] in d['toolIds']
                             and d['owner'] == 'RUNTIME' and d['action'] in ('INJECT', 'MOVE_TO_RUNTIME')]}
    return registry


def citation_errors(value, files):
    """Give the agent exact feedback before it closes its read-only analysis/review."""
    errors = []
    def visit(node, location):
        if isinstance(node, list):
            for index, item in enumerate(node):
                visit(item, f'{location}[{index}]')
        elif isinstance(node, dict):
            if isinstance(node.get('path'), str) and isinstance(node.get('snippet'), str):
                path = node['path'].replace('\\', '/').removeprefix('./')
                resolved = path if path in files else None
                if resolved is None:
                    segments = path.split('/')
                    for index in range(len(segments)):
                        tail = '/'.join(segments[index:])
                        hits = [key for key in files if key == tail or key.endswith('/' + tail)]
                        if len(hits) == 1:
                            resolved = hits[0]
                            break
                        if len(hits) > 1:
                            break
                text = files.get(resolved, '')
                normalize = lambda s: s.replace('\r\n', '\n').replace('\r', '\n')
                if not resolved or not node['snippet'] or normalize(node['snippet']) not in normalize(text):
                    errors.append({'location': location, 'path': node['path'],
                                   'error': 'Quote a short contiguous verbatim passage from the actual file; retain Markdown escapes. Re-read the file before resubmitting.'})
            for key, item in node.items():
                visit(item, location + '.' + key)
    visit(value, 'result')
    return errors



def analysis_sample_errors(analysis):
    # Use precisely the same wire contract as later independent execution.
    try:
        from .migration_tools import _declared_shape_ok
    except ImportError:
        from migration_tools import _declared_shape_ok
    errors = []
    for tool_id, entry in bundle_contract_registry(analysis).items():
        if 'sampleInput' not in entry:
            continue
        valid, detail = _declared_shape_ok(entry['sampleInput'], entry['inputSchema'])
        if not valid:
            errors.append(f'{tool_id}: sampleInput does not match the execution inputSchema: {detail}. Describe the complete wire envelope in inputSchema; do not remove business or identity fields to pass validation.')
    return errors


def correct_result_fields(draft, corrections, files):
    result = json.loads(json.dumps(draft))
    for correction in corrections:
        pointer = correction['path']
        if not pointer.startswith('/') or pointer == '/':
            raise ValueError('Use a JSON pointer to a result field')
        keys = [part.replace('~1', '/').replace('~0', '~') for part in pointer[1:].split('/')]
        parent = result
        for key in keys[:-1]:
            parent = parent[int(key)] if isinstance(parent, list) else parent[key]
        if 'sourcePath' in correction:
            name = correction['sourcePath']
            if name not in files:
                raise ValueError('Quote path must identify an actual package file')
            lines = base64.b64decode(files[name]).decode('utf-8').splitlines()
            first, last = correction['startLine'], correction['endLine']
            if not isinstance(first, int) or not isinstance(last, int) or not 1 <= first <= last <= len(lines):
                raise ValueError('Invalid quote line range')
            snippet = '\n'.join(lines[first-1:last])
            # A correction may address either the evidence object or one of its
            # fields. Runtime capability evidence uses a line and detail while
            # source citations use a snippet; both refer to the same real lines.
            if keys[-1] == 'path':
                value = name
            elif keys[-1] == 'line':
                value = first
            elif keys[-1] in ('snippet', 'detail'):
                value = snippet
            elif 'requiredCapabilities' in keys and 'evidence' in keys:
                value = {'path': name, 'line': first, 'detail': snippet}
            else:
                value = {'path': name, 'snippet': snippet}
        else:
            value = correction['value']
        key = keys[-1]
        if isinstance(parent, list):
            parent[int(key)] = value
        else:
            parent[key] = value
    return result


async def run_bundle(body, protocol, controls=None):
    from openjiuwen.core.foundation.tool import LocalFunction, ToolCard
    from openjiuwen.core.sys_operation import SysOperation
    from openjiuwen.core.sys_operation.base import OperationMode
    from openjiuwen.core.sys_operation.config import LocalWorkConfig
    from openjiuwen.core.sys_operation.sys_operation import SysOperationCard
    from openjiuwen.harness.tools import EditFileTool, WriteFileTool
    from openjiuwen.harness.tools.base_tool import ToolOutput
    from openjiuwen.core.common.exception.codes import StatusCode
    from openjiuwen.core.single_agent.rail.base import AgentRail
    from analysis_file_tools import WorkspaceReadFileTool, WorkspaceGlobTool, WorkspaceListDirTool, analysis_path, check_analysis_tree
    from workspace_paths import candidate_path
    from agent_execution import assemble_agent
    from migration_checkpoint import MigrationCheckpoint, checkpoint_identity
    from migration_tools import build_compile_tool, build_grep_tool, build_contract_test_tool, build_contract_suite_tool, build_run_scanner, _contract_test, _contract_suite
    from model_config import resolve_model, request_settings
    from agent_activity import stream_agent
    from agent_session import TaskAgentSession, install_task_checkpointer
    from agent_conversation_store import ConversationStore
    from agent_workspace import TaskWorkspace
    from workspace_candidate import prepare_candidate
    from session_identity import persistent_workspace_scope, task_session_identity

    bundle = body['bundle']
    if bundle.get('mode') != 'CHAT':
        raise ValueError('Migration execution requires the main Agent conversation; phase intents are adapted by the task service')
    started = time.monotonic()
    source = bundle['source']['files']
    files = {'source/' + name: base64.b64decode(value, validate=True) for name, value in source.items()}
    files.update({'candidate/' + name: base64.b64decode(value, validate=True) for name, value in body['files'].items()})
    if bundle['mode'] != 'PREPARE':
        specification = (Path(__file__).resolve().parents[2] / 'docs/2.0/skill-specification.md').read_bytes()
        files['task/skill-specification.md'] = specification
        bundle.setdefault('standardizationGuide', {})['specification'] = {
            'path': 'task/skill-specification.md', 'sha256': hashlib.sha256(specification).hexdigest()}
    platform_root = Path(__file__).resolve().parents[2]
    process_source = platform_root / 'contracts/runtime-launcher/finance.runtime-process.v1.schema.json'
    references = {
        'task/platform/launcher-contract.md': platform_root / 'contracts/runtime-launcher/README.md',
        'task/platform/runtime-process' + process_source.suffix: process_source,
        'task/platform/service-templates.md': platform_root / 'src/resources/agents/v1/references/service-templates.md',
        'task/platform/tool-form-selection.md': platform_root / 'src/resources/agents/v1/references/tool-form-selection.md',
    }
    available_references = []
    for name, path in references.items():
        if path.is_file():
            contents = path.read_bytes()
            files[name] = contents
            available_references.append({'path': name, 'sha256': hashlib.sha256(contents).hexdigest()})
    checkpoint = None
    resumed = False
    correlation = body.get('correlation') or {}
    if bundle['mode'] in ('GENERATE', 'REPAIR', 'CHAT') and isinstance(correlation, dict):
        task_id, attempt_id = correlation.get('taskId'), correlation.get('attemptId')
        if isinstance(task_id, str) and isinstance(attempt_id, str):
            root = body.get('checkpointRoot') or os.environ.get('FINANCE_EVAL_DATA_DIR') or str(Path(__file__).resolve().parents[2] / 'data')
            checkpoint = MigrationCheckpoint(root, task_id, attempt_id, checkpoint_identity(bundle, body['assetDigest']))
            attempts = bundle.get('resumeDraftAttemptIds')
            saved = next((draft for prior in attempts if (draft := checkpoint.load(prior)) is not None), None) if isinstance(attempts, list) else None
            if saved is not None:
                try:
                    decoded = {'candidate/' + name: base64.b64decode(value, validate=True) for name, value in saved.items()}
                    if any(not isinstance(name, str) or not name or name.startswith(('/', '\\')) or '..' in name.replace('\\', '/').split('/') for name in saved):
                        raise ValueError('Invalid draft path')
                    files = {name: value for name, value in files.items() if not name.startswith('candidate/')}
                    files.update(decoded)
                    resumed = True
                except (ValueError, TypeError):
                    resumed = False
                if resumed:
                    try:
                        checkpoint.save(saved)
                    except OSError as error:
                        emit(protocol, {'activity': {'kind': 'warning', 'label': '工作草稿保存失败', 'text': type(error).__name__}})
    if resumed:
        bundle['resumedEngineeringDraft'] = True
        emit(protocol, {'activity': {'kind': 'progress', 'label': '已恢复上次中断的工作草稿，仍需检查和正式提交'}})
    manifest = {key: value for key, value in bundle.items() if key != 'source'}
    manifest['platformReferences'] = available_references
    if bundle['mode'] == 'CHAT' and isinstance(bundle.get('feedback'), dict):
        manifest['feedback'] = discussion_manifest_feedback(bundle['feedback'])
    # Keep large plans readable in bounded line ranges; a single JSON line can
    # exceed the agent's file-reading limit and make targeted inspection fail.
    files['task/manifest.json'] = json.dumps(manifest, ensure_ascii=False, indent=2)
    session_settings = body.get('taskSession')
    task_workspace = None
    session_id = None
    conversation = None
    checkpointer = None
    session = None
    if session_settings is not None:
        if not isinstance(session_settings, dict) or not isinstance(correlation.get('taskId'), str):
            raise ValueError('Task session requires a task correlation')
        root = Path(body['checkpointRoot']).resolve() / 'migration-agent'
        scope = persistent_workspace_scope(root)
        session_id = task_session_identity(scope, correlation['taskId'])
        source_digest = hashlib.sha256(json.dumps(source, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        task_workspace = TaskWorkspace(root, session_id)
        task_workspace.__enter__()
        try:
            workspace = task_workspace.initialize(files, source_digest)
            # The workspace survives turns; refresh trusted task instructions for
            # a new operation but preserve the exact input when resuming a question.
            check_analysis_tree(workspace)
            prepare_candidate(workspace, Path(body['checkpointRoot']), correlation['taskId'], correlation.get('attemptId'),
                body['assetDigest'], {name.removeprefix('candidate/'): value for name, value in files.items() if name.startswith('candidate/')},
                answering=session_settings.get('answer') is not None or session_settings.get('resumePaused') is True or session_settings.get('recoverCheckpoint') is True)
            if session_settings.get('answer') is None and session_settings.get('resumePaused') is not True and session_settings.get('recoverCheckpoint') is not True:
                (workspace / 'task' / 'manifest.json').write_text(files['task/manifest.json'], encoding='utf-8')
                if 'task/skill-specification.md' in files:
                    (workspace / 'task' / 'skill-specification.md').write_bytes(files['task/skill-specification.md'])
                for reference in available_references:
                    destination=workspace / reference['path']
                    destination.parent.mkdir(parents=True,exist_ok=True)
                    destination.write_bytes(files[reference['path']])
            checkpointer = await install_task_checkpointer(root)
            conversation = ConversationStore(root)
            await conversation.initialize()
        except BaseException:
            task_workspace.__exit__(None, None, None)
            raise
    else:
        workspace = build_workspace(files)
    candidate = workspace / 'candidate'
    trace = []
    result, bound, failure = {}, {}, ''
    model_calls = []
    receipt = None
    activity = None
    review_snapshots = None
    executions = []
    evaluation_requested = []
    review_requested = []
    runtime_preparation_requested = []
    composition = None
    checkpoint_lock = asyncio.Lock()
    async def save_checkpoint():
        if checkpoint is None:
            return
        try:
            async with checkpoint_lock:
                await asyncio.to_thread(lambda: checkpoint.save(collect_candidate(candidate)))
        except (OSError, ValueError) as error:
            emit(protocol, {'activity': {'kind': 'warning', 'label': '工作草稿保存失败', 'text': type(error).__name__}})
    def redact(value):
        text = str(value)
        for key in ('apiKey', 'baseUrl'):
            secret = bound.get(key)
            if secret:
                text = text.replace(secret, '[redacted]')
        return text
    def dump():
        write_agent_dump('bundle-' + body['runId'], redact(json.dumps(
            {'mode': bundle['mode'], 'result': result, 'error': failure, 'trace': trace,
             'modelCalls': model_calls, 'composition': receipt}, ensure_ascii=False, default=str)))
    class ModelEvidenceRail(AgentRail):
        async def before_model_call(self, ctx):
            if evaluation_requested or review_requested or runtime_preparation_requested:
                ctx.request_force_finish({'output': '正在准备所选运行环境' if runtime_preparation_requested else '正在运行开发集评测' if evaluation_requested else '正在请求独立效果审查' if review_requested else '提交完成', 'result_type': 'answer'})

        async def after_tool_call(self, ctx):
            if evaluation_requested or review_requested or runtime_preparation_requested:
                ctx.request_force_finish({'output': '正在准备所选运行环境' if runtime_preparation_requested else '正在运行开发集评测' if evaluation_requested else '正在请求独立效果审查' if review_requested else '提交完成', 'result_type': 'answer'})

        async def after_model_call(self, ctx):
            response = ctx.inputs.response
            model_calls.append({
                'contentLength': len(str(getattr(response, 'content', '') or '')),
                'toolCallCount': len(getattr(response, 'tool_calls', None) or []),
                'toolNames': [getattr(call, 'name', '') for call in (getattr(response, 'tool_calls', None) or [])],
                'finishReason': getattr(response, 'finish_reason', None),
                'usage': getattr(response, 'usage_metadata', None),
            })
            dump()
    try:
        composition = load_bundle_role(bundle['mode'], body.get('agentRoleVersion', 'v1'), bundle.get('adjustmentCapabilities'))
        # Enforce read-only source/task at tool invocation, not just in the prompt.
        class CandidateWrite(WriteFileTool):
            async def invoke(self, inputs, **kwargs):
                if bundle.get('agentOptimization') and bundle['agentOptimization'].get('status') != 'RUNNING':
                    return ToolOutput(success=False, error='优化已停止，请先由用户决定后续工作')
                try:
                    target = candidate_path(candidate, inputs.get('file_path', ''))
                    check_analysis_tree(workspace)
                except (ValueError, OSError) as error:
                    return ToolOutput(success=False, error=str(error))
                result = await super().invoke({**inputs, 'file_path': str(target)}, **kwargs)
                # SDK 0.1.17 treats a fully read empty file as "0 of 0 lines"
                # and refuses every overwrite. No unread content exists in that case.
                content = inputs.get('content')
                if (not result.success and 'of 0 lines' in str(result.error or '')
                        and target.is_file() and target.stat().st_size == 0 and isinstance(content, str)
                        and len(content.encode('utf-8', errors='replace')) <= self.MAX_CONTENT_SIZE):
                    written = await operation.fs().write_file(str(target), content, prepend_newline=False,
                                                               create_if_not_exist=True, encoding='utf-8')
                    result = (ToolOutput(success=True, data={'file_path': str(target), 'type': 'update'})
                              if written.code == StatusCode.SUCCESS.code else ToolOutput(success=False, error=written.message))
                if result.success:
                    await save_checkpoint()
                return result

        class CandidateEdit(EditFileTool):
            async def invoke(self, inputs, **kwargs):
                if bundle.get('agentOptimization') and bundle['agentOptimization'].get('status') != 'RUNNING':
                    return ToolOutput(success=False, error='优化已停止，请先由用户决定后续工作')
                try:
                    target = candidate_path(candidate, inputs.get('file_path', ''))
                    check_analysis_tree(workspace)
                except (ValueError, OSError) as error:
                    return ToolOutput(success=False, error=str(error))
                result = await super().invoke({**inputs, 'file_path': str(target)}, **kwargs)
                if result.success:
                    await save_checkpoint()
                return result

        skill_root = Path(__file__).resolve().parents[2] / 'src/resources/agents/v1/skills'
        sandbox_roots = [str(workspace)] + ([str(skill_root)] if session_settings is not None else [])
        operation = SysOperation(SysOperationCard(id='bundle-' + body['runId'], mode=OperationMode.LOCAL,
            work_config=LocalWorkConfig(restrict_to_sandbox=True, sandbox_root=sandbox_roots, shell_allowlist=[])))
        args = (operation, 'cn', 'bundle-' + body['runId'])
        tools = [WorkspaceReadFileTool(workspace, *args), WorkspaceGlobTool(workspace, *args),
                 WorkspaceListDirTool(workspace, *args), build_grep_tool(workspace, trace)]
        stage_state = None
        if session_id is not None:
            attempt_id = correlation.get('attemptId')
            if not isinstance(attempt_id, str) or not re.fullmatch(r'attempt-[a-f0-9-]+', attempt_id):
                raise ValueError('Task session requires a valid attempt ID')
            stage_state = workspace / 'task' / ('.session-' + attempt_id + '.json')
            if session_settings.get('answer') is not None or session_settings.get('resumePaused') is True:
                state = json.loads(stage_state.read_text(encoding='utf-8'))
                # Existing pending questions used phase labels for this same
                # stable task session. Reuse execution receipts, not old result drafts.
                if state.get('mode') not in ('CHAT', 'PREPARE', 'ANALYZE', 'GENERATE', 'REPAIR'):
                    raise ValueError('Waiting interaction belongs to another operation')
                executions.extend(state.get('executions', []))
                evaluation_requested.extend(state.get('evaluationRequested', []))
                review_requested.extend(state.get('reviewRequested', []))
                runtime_preparation_requested.extend(state.get('runtimePreparationRequested', []))
        async def persist_stage_state():
            if stage_state is None:
                return
            state = {'mode': 'CHAT', 'executions': executions,
                     'evaluationRequested': evaluation_requested, 'reviewRequested': review_requested,
                     'runtimePreparationRequested': runtime_preparation_requested}
            fd, temporary = tempfile.mkstemp(prefix='.stage-state-', dir=stage_state.parent)
            try:
                with os.fdopen(fd, 'w', encoding='utf-8') as output:
                    json.dump(state, output, ensure_ascii=False)
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(temporary, stage_state)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
        registry = bundle_contract_registry(bundle.get('analysis') or {})
        async def delete_file(file_path):
            if bundle.get('agentOptimization') and bundle['agentOptimization'].get('status') != 'RUNNING':
                return {'accepted': False, 'error': '优化已停止，请先由用户决定后续工作'}
            try:
                target = candidate_path(candidate, file_path)
                check_analysis_tree(workspace)
                if target == candidate or not target.is_file():
                    return {'accepted': False, 'error': 'Only an existing candidate file can be deleted'}
                target.unlink()
                await save_checkpoint()
                return {'deleted': True, 'file_path': target.relative_to(candidate).as_posix()}
            except (ValueError, OSError, RuntimeError) as error:
                return {'accepted': False, 'error': str(error)}

        tools += [CandidateWrite(*args), CandidateEdit(*args), LocalFunction(ToolCard(
            id='bundle-delete-file', name='delete_file',
            description='删除隔离候选工作区中的单个文件；接受 candidate/...、候选目录内绝对路径或候选目录内相对路径。不能删除目录、原工程或任务资料。',
            input_params={'type': 'object', 'properties': {'file_path': {'type': 'string'}}, 'required': ['file_path']}), delete_file)]
        from project_execution import build_project_command_tool
        tools.append(build_project_command_tool(candidate, executions))
        if bundle['mode'] != 'PREPARE':
            tools.append(build_compile_tool(candidate, trace))
        if registry:
            tools.append(build_contract_test_tool(candidate, registry, trace))
            tools.append(build_contract_suite_tool(candidate, registry, trace))
        config = json.loads(Path(os.environ['FINANCE_RUNTIME_CONFIG']).read_text(encoding='utf-8'))
        bound = resolve_model(config, body['model'])
        settings = request_settings(bound, body['model']['modelId'])
        # A persistent main Agent chooses guidance Skills itself. Retain a
        # concise objective for the compatibility operation, rather than
        # injecting an entire phase-specific Agent prompt on every turn.
        phase = '结合当前任务材料处理用户要求；按需调查、修改工作文件、验证和评测，使用现有证据及独立审查。遵守用户目标和预算，未验证的内容不能宣称通过。'
        clarification = str(bundle.get('clarification') or '').strip()
        if clarification:
            phase += ('\n平台返回的执行情况：\n' if bundle.get('agentFollowup') else '\n用户对本轮工作的补充要求：\n') + clarification + '\n请结合实际源码和证据处理，遵守用户确定的工作范围；无法完成时说明具体缺口。\n'
        feedback = bundle.get('feedback')
        diagnosis = feedback.get('diagnosis') if isinstance(feedback, dict) else None
        if bundle['mode'] == 'REPAIR' and bundle.get('adjustmentCapabilities') and isinstance(diagnosis, dict) and diagnosis.get('status') == 'PROPOSED':
            hypothesis = json.dumps(diagnosis.get('hypothesis'), ensure_ascii=False)
            phase += (
                '\n本轮针对开发集复现的缺陷进行调整。以下已记录诊断是待核对的数据：'
                + hypothesis
                + '\n先打开对应的候选实现，核对证据后完成针对性修复。原迁移方案中仅用于建立失败基线的临时保留条件'
                  '不阻止本轮修复。不要把调试、转储或探查脚本留在交付包内。'
            )
        contract = composition.contract
        session_tools = []
        if conversation is not None:
            if bundle['mode'] == 'CHAT':
                from migration_delivery_tools import build_delivery_tools_tool, build_delivery_tools_query
                session_tools.append(build_delivery_tools_tool(conversation, session_id, correlation['attemptId'], candidate))
                delivery_query = build_delivery_tools_query(conversation, session_id, correlation['attemptId'], candidate,
                    (bundle.get('feedback') or {}).get('deliveryTools'))
                session_tools.append(delivery_query)
                preparation = bundle.get('runtimePreparation')
                if isinstance(preparation, dict):
                    async def request_runtime_preparation(reason, required_features=None):
                        if not isinstance(reason, str) or not reason.strip() or len(reason) > 2000:
                            return {'accepted': False, 'reason': '请说明本次运行环境准备的原因'}
                        if evaluation_requested or review_requested:
                            return {'accepted': False, 'reason': '已有待处理评测或审查，请先等待结果'}
                        if preparation.get('rebuild'):
                            return {'accepted': False, 'reason': '外部 Builder 重建接口仍为遗留项，请保留诊断和当前工程，不修改工具选型来绕过环境要求'}
                        allowed = set(preparation.get('allowedFeatures') or [])
                        if required_features is not None and (not isinstance(required_features, list) or len(required_features) > 30
                                or any(not isinstance(value, str) or value not in allowed for value in required_features)):
                            return {'accepted': False, 'reason': '请使用平台现有的 Runtime 能力名称'}
                        if not runtime_preparation_requested:
                            runtime_preparation_requested.append({'requestId': preparation['requestId'], 'reason': reason.strip(),
                                                                 **({'requiredFeatures': list(dict.fromkeys(required_features))} if required_features else {})})
                        return {'accepted': True, 'note': '已请求准备用户选定的新 Runtime；结束本轮说明后由平台处理，完成后继续同一主会话，不要在本轮请求评测或继续改写。'}
                    session_tools.append(LocalFunction(ToolCard(id='migration-request-runtime-preparation', name='request_runtime_preparation',
                        description='请求准备用户已明确选择的新 Runtime，复用现有 Builder 接入及启动核验。只能处理 task/manifest.json 中已选定的需求；不自行选择部署方案，不支持外部重建接口。',
                        input_params={'type':'object','properties':{'reason':{'type':'string'},
                            'required_features':{'type':'array','items':{'type':'string'},'description':'源码和工具方案所需的既有 Runtime 能力，如 externalMcp、toolProcessEvidence；不能为适应缺失客户端而降低工具方案。'}},
                            'required':['reason']}), request_runtime_preparation))
                from evaluation_case_proposal import build_case_proposal_tool
                session_tools.append(build_case_proposal_tool(conversation, session_id, correlation['attemptId'], redact))
                continuation = bundle.get('budgetContinuation')
                if isinstance(continuation, dict) and isinstance(continuation.get('ownerAttemptId'), str):
                    from optimization_budget_tool import build_budget_continuation_tool
                    session_tools.append(build_budget_continuation_tool(conversation, session_id, correlation['attemptId'], continuation['ownerAttemptId']))
                async def record_task_goal(goal, target=None):
                    if not isinstance(goal, str) or not goal.strip() or len(goal) > 2000:
                        return {'accepted': False, 'reason': '请提供不超过 2000 字的完整任务目标'}
                    if target is not None and (not isinstance(target, str) or not target.strip() or len(target) > 2000):
                        return {'accepted': False, 'reason': '交付目标应为不超过 2000 字的非空文本'}
                    from uuid import uuid4
                    sequence = await conversation.append(session_id, 'task-goal:' + uuid4().hex, 'task_goal',
                                                         {'goal': redact(goal.strip()), 'attemptId': correlation['attemptId'],
                                                          **({'target': redact(target.strip())} if target is not None else {})})
                    return {'accepted': True, 'sequence': sequence,
                            'note': '已记录任务目标；原有审查会按新目标重新核对。'}
                session_tools.append(LocalFunction(ToolCard(id='migration-record-task-goal', name='record_task_goal',
                    description='仅在用户明确新增、改变或缩小本任务目标或范围时调用；用完整自然语言记录更新后的目标并保留未被取消的约束。只有用户明确改变交付目标时才填写 target。普通讨论和未获用户确定的建议不要调用。目标变更会使原审查重新核对。',
                    input_params={'type': 'object', 'properties': {'goal': {'type': 'string'}, 'target': {'type': 'string'}}, 'required': ['goal']}), record_task_goal))
                from development_evidence import build_evaluation_evidence_tool
                from bundle_runtime import files_digest
                evaluations = (bundle.get('feedback') or {}).get('developmentEvaluations') or []
                def current_candidate_digest():
                    return files_digest({name: base64.b64decode(value) for name, value in collect_candidate(candidate).items()})
                session_tools.append(build_evaluation_evidence_tool(evaluations, current_candidate_digest))
                if not bundle.get('agentFollowup') or bundle.get('agentCanReview'):
                    async def request_effect_review(candidate_run_id, baseline_run_id=None):
                        if evaluation_requested or review_requested or runtime_preparation_requested:
                            return {'accepted': False, 'reason': '已有待处理操作，请等待结果'}
                        if bundle.get('reviewAvailable') is not True:
                            return {'accepted': False, 'reason': '独立审查 Agent 尚未配置'}
                        if not isinstance(candidate_run_id, str) or not candidate_run_id.strip():
                            return {'accepted': False, 'reason': '请选择当前工作的开发集评测记录'}
                        if baseline_run_id is not None and (not isinstance(baseline_run_id, str) or not baseline_run_id.strip()):
                            return {'accepted': False, 'reason': '未提供原工程基线时省略 baseline_run_id；不能填空基线'}
                        if baseline_run_id == candidate_run_id:
                            return {'accepted': False, 'reason': '基线和候选必须是两次独立评测'}
                        baseline = next((item for item in evaluations if isinstance(item, dict) and item.get('runId') == baseline_run_id), None)
                        reviewed = next((item for item in evaluations if isinstance(item, dict) and item.get('runId') == candidate_run_id), None)
                        if not reviewed or reviewed.get('status') == 'UNAVAILABLE' or baseline_run_id is not None and (not baseline or baseline.get('status') == 'UNAVAILABLE'):
                            return {'accepted': False, 'reason': '评测记录不存在或材料暂不可用，请先查询开发集证据'}
                        opt = bundle.get('agentOptimization') or {}
                        if opt and (opt.get('phase') != 'REVIEW' or opt.get('workingRunId') != baseline_run_id):
                            return {'accepted': False, 'reason': '请使用本轮基线和本轮评测请求审查'}
                        if reviewed.get('candidateDigest') != current_candidate_digest():
                            return {'accepted': False, 'reason': '当前文件与评测版本不同，请先重新评测'}
                        review_requested.append({'candidateRunId': candidate_run_id,
                            **({'baselineRunId': baseline_run_id} if baseline_run_id is not None else {})})
                        return {'accepted': True, 'note': '平台会核对冻结版本和可比证据，再请求独立审查。'}
                    session_tools.append(LocalFunction(ToolCard(id='migration-request-effect-review', name='request_effect_review',
                        description='请求独立审查当前开发集结果是否满足用户目标。用 query_development_evaluations 查找真实 runId。只有需要比较提升或正在持续优化时才提供 baseline_run_id；没有原工程基线时省略该参数，只证明目标达成，不宣称提升。当前工作必须与评测的文件版本一致。',
                        input_params={'type': 'object', 'properties': {'baseline_run_id': {'type': 'string'},
                            'candidate_run_id': {'type': 'string'}}, 'required': ['candidate_run_id']}), request_effect_review))
                optimization = bundle.get('agentOptimization') or {}
                if not optimization or (optimization.get('status') == 'RUNNING' and (
                        optimization.get('phase') == 'ADJUSTMENT' and optimization.get('remainingRounds', 0) > 0
                        or optimization.get('phase') == 'EVALUATION' and optimization.get('resumePendingEvaluation') is True)):
                    async def queue_development_evaluation(optimization_goal=None):
                        if evaluation_requested or review_requested or runtime_preparation_requested:
                            return {'accepted': False, 'reason': '已有待处理操作，请等待结果'}
                        availability = bundle.get('evaluationAvailability') or {}
                        if availability.get('ready') is not True:
                            return {'accepted': False, 'reason': availability.get('reason') or '开发集评测条件尚未准备'}
                        request = None
                        if optimization.get('resumePendingEvaluation') and optimization.get('pendingCandidateDigest') != current_candidate_digest():
                            return {'accepted': False, 'reason': '工作文件与待重试的评测版本不一致'}
                        if optimization and not optimization.get('resumePendingEvaluation') and not optimization.get('runtimeChanged') and optimization.get('workingDigest') == current_candidate_digest():
                            return {'accepted': False, 'reason': '工作文件尚无变化，请先诊断并调整'}
                        if optimization_goal is not None:
                            import math
                            if optimization or not isinstance(optimization_goal, dict):
                                return {'accepted': False, 'reason': '优化目标无效或当前优化已开始'}
                            if bundle.get('reviewAvailable') is not True:
                                return {'accepted': False, 'reason': '独立审查 Agent 尚未配置，不能启动优化循环'}
                            goal = optimization_goal.get('goal')
                            rounds = optimization_goal.get('maxRounds')
                            target = optimization_goal.get('targetPassRate')
                            baseline_id = optimization_goal.get('baselineRunId')
                            protected = optimization_goal.get('protectedCaseIds')
                            if (not isinstance(goal, str) or not goal.strip() or not isinstance(rounds, int) or isinstance(rounds, bool)
                                    or rounds < 1 or rounds > 9007199254740991 or not isinstance(target, (int, float)) or isinstance(target, bool)
                                    or not math.isfinite(target) or not 0 <= target <= 1 or not isinstance(baseline_id, str) or not baseline_id):
                                return {'accepted': False, 'reason': '请提供用户确定的优化目标、正整数轮次预算、目标通过率和开发集基线'}
                            if protected is not None and (not isinstance(protected, list) or any(not isinstance(item, str) or not item.strip() for item in protected)
                                    or len(set(protected)) != len(protected)):
                                return {'accepted': False, 'reason': '必须通过案例的标识无效或重复'}
                            baseline = next ( (item for item in evaluations if isinstance(item, dict) and item.get('runId') == baseline_id), None)
                            if not baseline or (baseline.get('effectStatus') or baseline.get('status')) not in ('PASSED', 'FAILED') or baseline.get('candidateDigest') != body['assetDigest']:
                                return {'accepted': False, 'reason': '请先对本轮开始时的文件建立完整开发集基线'}
                            if current_candidate_digest() == body['assetDigest']:
                                return {'accepted': False, 'reason': '工作文件尚无变化，请先诊断并调整'}
                            duration = optimization_goal.get('maxDurationSeconds')
                            if duration is not None and (not isinstance(duration, int) or isinstance(duration, bool) or not 60 <= duration <= 7200):
                                return {'accepted': False, 'reason': '时间预算应为 60 至 7200 秒；未指定时仅按轮次控制'}
                            request = {'baselineRunId': baseline_id, 'goal': {'goal': goal.strip(), 'maxRounds': rounds,
                                'targetPassRate': target, **({'maxDurationSeconds': duration} if duration is not None else {}),
                                **({'protectedCaseIds': protected} if protected is not None else {})}}
                        evaluation_requested.append(request or {})
                        return {'accepted': True, 'note': '将冻结当前文件并运行已配置的开发集，完成后继续当前会话。'}
                    async def request_development_evaluation():
                        return await queue_development_evaluation()

                    async def request_optimization(baselineRunId, goal, maxRounds, targetPassRate,
                                                   maxDurationSeconds=None, protectedCaseIds=None):
                        return await queue_development_evaluation({'baselineRunId': baselineRunId,
                            'goal': goal, 'maxRounds': maxRounds, 'targetPassRate': targetPassRate,
                            **({'maxDurationSeconds': maxDurationSeconds} if maxDurationSeconds is not None else {}),
                            **({'protectedCaseIds': protectedCaseIds} if protectedCaseIds is not None else {})})

                    session_tools.append(LocalFunction(ToolCard(id='migration-request-development-evaluation',
                        name='request_development_evaluation', description='单次效果评测：冻结当前文件并运行用户已配置的开发集，完成后返回同一会话。调用参数为 {}，不需要基线、优化目标或轮次。不能运行留出集或修改判据。',
                        input_params={'type': 'object', 'properties': {}, 'additionalProperties': False}), request_development_evaluation))
                    if not optimization and not bundle.get('agentFollowup'):
                        session_tools.append(LocalFunction(ToolCard(id='migration-request-optimization',
                            name='request_optimization', description='仅当用户明确要求持续优化且给出目标、轮次和目标通过率时启动。先取得本轮起点的真实开发集基线 runId，并已完成一次针对性调整。单次效果评测应调用 request_development_evaluation({})。未指定总时间预算时不填 maxDurationSeconds。',
                            input_params={'type': 'object', 'properties':{
                            'baselineRunId':{'type':'string'},'goal':{'type':'string'},'maxRounds':{'type':'integer'},'targetPassRate':{'type':'number'},'maxDurationSeconds':{'type':'integer'},
                            'protectedCaseIds':{'type':'array','items':{'type':'string'}}},
                            'required':['baselineRunId','goal','maxRounds','targetPassRate']}), request_optimization))
            from uuid import uuid4
            async def publish_work_product(product_id, title, content):
                if not all(isinstance(value, str) and value.strip() for value in (product_id, title, content)):
                    return {'accepted': False, 'error': '工作产物需要标识、标题和内容'}
                if len(product_id) > 128 or len(title) > 200 or len(content) > 100000:
                    return {'accepted': False, 'error': '工作产物内容超过长度限制'}
                payload = {'id': product_id.strip(), 'title': redact(title.strip()), 'content': redact(content),
                           'attemptId': correlation['attemptId']}
                sequence = await conversation.append(session_id, 'work-product:' + uuid4().hex, 'work_product', payload)
                return {'accepted': True, 'sequence': sequence,
                        'note': '已记录工作产物；该记录不代表验证通过或候选已采纳'}
            session_tools.append(LocalFunction(ToolCard(id='migration-publish-work-product', name='publish_work_product',
                description='创建或更新用户可查看的工作产物，如迁移方案、验证报告或优化方案。内容可使用自然语言和 Markdown；同一产物更新时沿用 product_id。此操作仅记录内容，不代表验证通过或候选已采纳。',
                input_params={'type': 'object', 'properties': {'product_id': {'type': 'string'},
                    'title': {'type': 'string'}, 'content': {'type': 'string'}},
                    'required': ['product_id', 'title', 'content']}), publish_work_product))
        agent, model, activity, receipt = assemble_agent(
            composition=composition, body=body, bound=bound, settings=settings,
            workspace=workspace, operation=operation, tools=tools, protocol=protocol, trace=trace,
            kind='deep',
            extra_rails=[ModelEvidenceRail()],
            task_session={'skill_roots': [str(skill_root)]} if session_settings is not None else None,
            session_tools=session_tools,
            prompt_suffix=(f'工作区绝对路径：{workspace}。读取使用工作区相对路径（如 task/manifest.json、'
                           'candidate/scripts/tool.py）。写入与编辑的相对路径以 candidate 为根（如 scripts/tool.py，'
                           '不再加 candidate/ 前缀）。也可用对应范围内的绝对路径。'))
        query = (phase + '按需要读取 task/manifest.json、源码及可用指导 Skill。无法完成时说明具体缺口。'
                 if session_settings is not None else
                 phase + '读取 task/manifest.json 和完整源码，完成本阶段。无法完成时返回 {"status":"ABSTAINED","reason":"具体缺口"}。')
        if session_id is not None:
            from openjiuwen.harness.workspace.workspace import WorkspaceNode
            todo_directory = agent.deep_config.workspace.get_node_path(WorkspaceNode.TODO)
            if todo_directory is None:
                raise ValueError('Agent workspace does not provide a TODO directory')
            (Path(todo_directory) / session_id).mkdir(parents=True, exist_ok=True)
            activity.attach_conversation(conversation, session_id, todo_directory,
                candidate_digest=current_candidate_digest if bundle['mode'] == 'CHAT' else None,
                attempt_id=correlation['attemptId'])
            if bundle['mode'] == 'CHAT':
                from delivery_review_snapshot import DeliveryReviewSnapshots
                review_snapshots = DeliveryReviewSnapshots(agent, workspace, source, evaluations,
                    (bundle.get('feedback') or {}).get('developmentExecutions') or [], executions,
                    delivery_query=delivery_query)
                activity.attach_review_snapshots(review_snapshots)
            session = TaskAgentSession(agent, session_id, activity, conversation, correlation['attemptId'], persist_stage_state)
            if controls is not None:
                controls.start(session)
            answer = session_settings.get('answer')
            if answer is not None:
                if not isinstance(answer, dict):
                    raise ValueError('Invalid task session answer')
                result = await session.answer(answer.get('interactionId'), answer.get('answers'))
            elif session_settings.get('resumePaused') is True:
                result = await session.run('', resume_paused=True)
            elif session_settings.get('recoverCheckpoint') is True:
                result = await session.run('', recover_checkpoint=True)
            else:
                goal = str(bundle.get('goal') or '').strip()
                if goal:
                    await conversation.append(session_id, 'goal:' + hashlib.sha256(goal.encode()).hexdigest(),
                                              'message', {'role': 'user', 'text': goal})
                if bundle['mode'] == 'CHAT' and not bundle.get('agentFollowup'):
                    await conversation.append(session_id, 'discussion:' + correlation['attemptId'],
                                              'message', {'role': 'user', 'text': clarification})
                result = await session.run(query)
            await activity.flush()
        else:
            result = await stream_agent(agent, {'query': query}, activity)
        if result.get('result_type') == 'interrupt':
            await persist_stage_state()
            emit(protocol, {'result': {'stage': body.get('stage', composition.role), 'assetDigest': body['assetDigest'],
                'status': 'WAITING', 'payload': {'interactions': result['interactions']}, 'files': {},
                'composition': receipt, 'trace': {'rounds': trace}, 'elapsedMs': round((time.monotonic()-started)*1000)}})
            return
        if bundle['mode'] == 'CHAT':
            output = str(result.get('output') or '').strip()
            if not output:
                raise ValueError(activity.last_model_error or '模型没有返回有效回答，工作与已完成验证已保留，可继续原任务')
            from optimization_budget_tool import latest_budget_request
            from migration_delivery_tools import latest_delivery_tools
            delivery_tools = await latest_delivery_tools(conversation, session_id, correlation['attemptId'], candidate) if conversation is not None else None
            budget_request = await latest_budget_request(conversation, session_id, correlation['attemptId']) if conversation is not None else None
            emit(protocol, {'result': {'stage': body.get('stage', composition.role), 'assetDigest': body['assetDigest'],
                'status': 'PRODUCED', 'payload': {'message': redact(output), 'executions': executions,
                    **({'deliveryTools': delivery_tools} if delivery_tools is not None else {}),
                    'deliveryReviews': await activity.persisted_delivery_reviews(),
                    'evaluationRequested': bool(evaluation_requested),
                    **({'runtimePreparationRequested': runtime_preparation_requested[0]} if runtime_preparation_requested else {}),
                    **({'budgetRequest': budget_request} if budget_request else {}),
                    **({'optimizationRequest': evaluation_requested[0]} if evaluation_requested and evaluation_requested[0] else {}),
                    **({'reviewRequested': review_requested[0]} if review_requested else {})},
                'files': collect_candidate(candidate),
                'composition': receipt, 'trace': {'rounds': trace}, 'elapsedMs': round((time.monotonic()-started)*1000)}})
            return
    except Exception as error:
        # Do not expose SDK diagnostics containing model configuration.
        failure = redact(type(error).__name__ + ': ' + str(error))[:800]
        emit(protocol, {'result': {'stage': body.get('stage', composition.role if composition else 'engineering'), 'assetDigest': body['assetDigest'], 'status': 'FAILED',
            'payload': {}, 'files': {}, 'error': '整组 Agent 执行失败：' + failure,
            'composition': receipt, 'trace': {'rounds': trace}, 'elapsedMs': round((time.monotonic()-started)*1000)}})
    finally:
        dump()
        if review_snapshots is not None:
            for call_id in list(review_snapshots.active):
                await review_snapshots.finish(call_id)
        if activity is not None:
            try:
                await activity.flush()
            except Exception:
                pass  # The error is handled during execution; still release the workspace lock.
        try:
            if controls is not None:
                await controls.close()
            if session is not None:
                await session.close()
        finally:
            if task_workspace is None:
                shutil.rmtree(workspace, ignore_errors=True)
            else:
                try:
                    if checkpointer is not None:
                        await checkpointer._kv_store.engine.dispose()
                finally:
                    task_workspace.__exit__(None, None, None)
