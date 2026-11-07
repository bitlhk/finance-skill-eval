"""Opt-in real model/Launcher/Agent test over the public native HTTP entry.

All editable files and tasks live under a new verification directory. No ports,
Judge or engineering Agent are replaced by fixtures; only business data is local.
Run with the checked interpreter and FINANCE_TEST_REAL_AGENT=1.
"""
import asyncio
import base64
import io
import json
import os
from pathlib import Path
import socket
import sys
from tempfile import mkdtemp, TemporaryDirectory
import time
import zipfile
import httpx


def port():
    with socket.socket() as server:
        server.bind(('127.0.0.1', 0))
        return server.getsockname()[1]


async def main():
    if os.getenv('FINANCE_TEST_REAL_AGENT') != '1':
        raise SystemExit('Set FINANCE_TEST_REAL_AGENT=1 to authorize real configured model calls')
    if '--optimization-only' not in sys.argv and not os.getenv('FINANCE_EVAL_PROJECT_EXECUTION_IMAGE', '').strip():
        raise SystemExit('Migration delivery verification requires FINANCE_EVAL_PROJECT_EXECUTION_IMAGE for real isolated basic tests')
    root = Path.cwd()
    resume_directory = sys.argv[sys.argv.index('--resume') + 1] if '--resume' in sys.argv else None
    directory = Path(resume_directory).resolve() if resume_directory else Path(mkdtemp(prefix='native-live-', dir=root / 'artifacts'))
    if not directory.is_relative_to(root / 'artifacts') or not directory.name.startswith('native-live-'):
        raise ValueError('Verification recovery only accepts its own isolated artifact directory')
    previous = json.loads((directory / 'verification.json').read_text(encoding='utf-8')) if resume_directory else {}
    connection = json.loads((directory / 'connection.json').read_text(encoding='utf-8')) if resume_directory else {}
    api_port, agent_port, business_port = (connection['api'], connection['agent'], connection['business']) if connection else (port(), port(), port())
    migration_port = connection.get('migrationBusiness', port())
    token = 'native-live-isolated-verification-token'
    env = {**os.environ, 'FINANCE_EVAL_DATA_DIR': str(directory), 'FINANCE_EVAL_PORT': str(api_port),
        'FINANCE_EVAL_HOST': '127.0.0.1', 'FINANCE_EVAL_ACCESS_TOKEN': token, 'FINANCE_EVAL_WORKSPACE_MODE': 'single',
        'FINANCE_EVAL_WORKSPACE_SUBJECT': '', 'FINANCE_EVAL_PUBLIC_DEMO': 'false',
        'FINANCE_EVAL_AGENT_RUNTIME_URL': f'http://127.0.0.1:{agent_port}', 'FINANCE_EVAL_AGENT_RUNTIME_PORT': str(agent_port),
        'FINANCE_RUNTIME_PORT': str(business_port), 'FINANCE_RUNTIME_HOST': '127.0.0.1',
        'FINANCE_EVAL_AGENT_MAX_ITERATIONS': '40', 'OPENBLAS_NUM_THREADS': '1', 'OMP_NUM_THREADS': '1', 'MKL_NUM_THREADS': '1'}
    processes, streams = [], []
    async def launch(name, module, extra=None):
        stream = (directory / (name + '.log')).open('ab' if resume_directory else 'wb')
        streams.append(stream)
        process = await asyncio.create_subprocess_exec(sys.executable, '-B', '-m', module,
            cwd=root, env={**env, **(extra or {})}, stdin=asyncio.subprocess.PIPE, stdout=stream, stderr=stream)
        processes.append(process)
    await launch('agent-runtime', 'integrations.openjiuwen.serve', {'FINANCE_RUNTIME_COMPONENT': 'agent-runtime'})
    await launch('business-launcher', 'integrations.openjiuwen.serve')
    await launch('migration-launcher', 'integrations.openjiuwen.serve', {'FINANCE_RUNTIME_PORT': str(migration_port)})
    await launch('api', 'api')
    headers = {'authorization': 'Bearer ' + token}
    evidence = {'directory': str(directory), 'checks': [], **previous}
    evidence.update(requestedFlow='migration' if '--migration-only' in sys.argv else 'optimization' if '--optimization-only' in sys.argv else 'platform', completed=False)
    evidence['checks'] = list(dict.fromkeys(evidence['checks']))
    (directory / 'connection.json').write_text(json.dumps({'api': api_port, 'agent': agent_port, 'business': business_port, 'migrationBusiness': migration_port}), encoding='utf-8')
    async with httpx.AsyncClient(base_url=f'http://127.0.0.1:{api_port}', headers=headers, timeout=180, trust_env=False) as client:
        async def request(method, path, **options):
            response = await client.request(method, path, **options)
            if not response.is_success:
                raise RuntimeError(f'{method} {path}: HTTP {response.status_code}: ' + response.text[:1500])
            return response.json()
        async def ready(url):
            deadline = time.monotonic() + 180
            while time.monotonic() < deadline:
                try:
                    response = await client.get(url, timeout=2)
                    if response.is_success:
                        return response.json()
                except httpx.HTTPError:
                    pass
                if any(process.returncode is not None for process in processes):
                    raise RuntimeError('A verification service stopped before readiness')
                await asyncio.sleep(.2)
            raise RuntimeError('Verification service readiness timed out')
        async def settle(path, terminal, timeout=3600):
            deadline, last = time.monotonic() + timeout, None
            while time.monotonic() < deadline:
                value = await request('GET', path)
                status = value.get('status') or (value.get('attempts') or [{}])[-1].get('status')
                if status != last:
                    print(json.dumps({'record': path, 'status': status}, ensure_ascii=False), flush=True)
                    last = status
                if status in terminal:
                    return value
                await asyncio.sleep(.5)
            raise RuntimeError('Live verification timed out; records retained at ' + path)
        try:
            print(json.dumps({'stage': 'waiting-api', 'directory': str(directory)}), flush=True)
            await ready('/api/health')
            print(json.dumps({'stage': 'waiting-agent-runtime'}), flush=True)
            await ready(f'http://127.0.0.1:{agent_port}/internal/health')
            print(json.dumps({'stage': 'waiting-business-launcher'}), flush=True)
            capabilities = await ready(f'http://127.0.0.1:{business_port}/v1/runtime-capabilities')
            await ready(f'http://127.0.0.1:{migration_port}/v1/runtime-capabilities')
            print(json.dumps({'stage': 'services-ready'}), flush=True)
            environment = (await request('GET', '/api/environments/' + previous['environmentId']) if previous.get('environmentId') else
                await request('POST', '/api/environments', json={'name': 'Real native verification Launcher',
                    'type': 'runtime_launcher', 'runtimeType': 'openjiuwen', 'baseUrl': f'http://127.0.0.1:{business_port}/'}))
            saved_job = await request('GET', '/api/runs/' + previous['sourceJobId']) if previous.get('sourceJobId') else None
            reusable = saved_job and saved_job['status'] == 'completed' and not saved_job.get('assessmentIncomplete')
            model_id = capabilities['defaultModelId']
            skill = ('---\nname: capacity-policy\nversion: 1.0.0\ndescription: 本地只读会议室容量检查\nallowed-tools: [bash]\n---\n'
                '# 容量规则\n使用本 Skill 目录中的 scripts/check_capacity.py，命令为 python <脚本绝对路径> <capacity> <people>。'
                '它是本地纯计算 CLI，不访问远程系统。必须真实调用 CLI，根据输出回答 ACCEPT 或 REJECT；不得凭空声称调用。'
                '沿用既有严格大于规则：capacity > people 才 ACCEPT，否则 REJECT。\n')
            script = ('import sys\ncapacity, people = map(int, sys.argv[1:])\n'
                'print("ACCEPT" if capacity > people else "REJECT")\n')
            output = io.BytesIO()
            with zipfile.ZipFile(output, 'w') as archive:
                archive.writestr('SKILL.md', skill)
                archive.writestr('scripts/check_capacity.py', script)
            if reusable:
                catalog = await request('GET', '/api/catalog')
                asset = next(asset for asset in catalog['uploadedSkills'] if asset['assetId'] == saved_job['configuration']['skillAssetId'])
            else:
                asset = await request('POST', '/api/skills/upload', content=output.getvalue(), headers={'content-type': 'application/zip'})
            suite = {'name': '容量边界真实缺陷', 'cases': [{'id': name, 'input': f'调用容量检查 CLI：capacity={capacity}, people=4。给出结论。',
                'criteria': [f'最终容量判断应为 {expected}。', '实际调用容量检查 CLI，以运行输出支撑答案。'],
                'criterionScopes': ['answer', 'execution'], 'repeatSafety': 'read_only'}
                for name, capacity, expected in [('equal', 4, 'ACCEPT'), ('insufficient', 3, 'REJECT'), ('larger', 5, 'ACCEPT')]], 'holdoutCases': []}
            preparation = {'preparationId': saved_job['configuration']['preparationId']} if reusable else await request('POST', f"/api/skills/{asset['assetId']}/prepare/import", json=suite)
            variant = {'mode': 'skill_version', **{key: asset[key] for key in ('skillId', 'version', 'artifactSha256')}}
            job = saved_job if reusable else await request('POST', '/api/runs', json={'preparationId': preparation['preparationId'], 'skillAssetId': asset['assetId'],
                'runtime': {'type': 'runtime_launcher', 'environmentId': environment['environmentId']},
                'executionModel': {'providerId': 'openjiuwen', 'modelId': model_id,
                    'parameters': {'temperature': 0, 'top_p': 1, 'max_tokens': 4000}},
                'leftVariant': variant, 'rightVariant': variant, 'judgeMode': 'model', 'runtimeHarnessTools': ['bash', 'read_file'], 'timeoutMs': 240000})
            evidence.update(sourceJobId=job['jobId'], environmentId=environment['environmentId'])
            job = await settle('/api/runs/' + job['jobId'], {'completed', 'failed', 'cancelled', 'interrupted'})
            (directory / 'source-job.json').write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding='utf-8')
            if job['status'] != 'completed' or job.get('assessmentIncomplete'):
                raise RuntimeError('Real baseline did not complete: ' + str(job.get('error')))
            evidence['checks'].append('real-launcher/comparison/process/judge')
            async def verify_optimization():
                optimized = await request('GET', '/api/optimizations/' + previous['optimizationId']) if previous.get('optimizationId') else None
                retained = ((optimized or {}).get('loop') or {}).get('rounds') or []
                if optimized and (optimized.get('candidate') or retained and retained[-1].get('candidate')) and optimized['status'] in ('interrupted', 'cancelled', 'failed'):
                    optimized = await request('POST', '/api/optimizations/' + optimized['optimizationId'] + '/recover')
                elif not optimized or optimized['status'] not in ('review', 'adopted'):
                    optimized = await request('POST', f"/api/runs/{job['jobId']}/optimize", json={'goal': '修复容量边界：容量等于人数也应 ACCEPT。一起修改 Skill 和 CLI 源码，保留本地只读 CLI 形式，实际复测并独立审查。',
                        'maxRounds': 1, 'targetPassRate': 1})
                evidence['optimizationId'] = optimized['optimizationId']
                (directory / 'verification.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding='utf-8')
                optimized = await settle('/api/optimizations/' + optimized['optimizationId'], {'review', 'retained', 'waiting', 'failed', 'cancelled', 'interrupted'})
                (directory / 'optimization.json').write_text(json.dumps(optimized, ensure_ascii=False, indent=2), encoding='utf-8')
                if optimized['status'] not in ('review', 'adopted') or not optimized.get('candidate') or (optimized.get('effectReview') or {}).get('status') != 'PRODUCED':
                    raise RuntimeError('Real optimization did not reach reviewed candidate: ' + str(optimized.get('error') or optimized.get('summary')))
                evidence['checks'].append('real-defect/diagnosis/engineering/retest/independent-review')
                changed = {item['path'] for item in optimized.get('changes', []) if item.get('before') != item.get('after')}
                if not {'SKILL.md', 'scripts/check_capacity.py'} <= changed:
                    raise RuntimeError('Optimization must deliver both the Skill and actual CLI code changes')
                if optimized['status'] != 'adopted':
                    optimized = await request('POST', '/api/optimizations/' + optimized['optimizationId'] + '/decision', json={'decision': 'adopt'})
                if optimized['status'] != 'adopted':
                    raise RuntimeError('Reviewed optimization was not adopted')
                (directory / 'optimization.json').write_text(json.dumps(optimized, ensure_ascii=False, indent=2), encoding='utf-8')
                evidence['checks'].append('reviewed-candidate/adoption')
            async def verify_migration():
                migration = (await request('GET', '/api/migration-tasks/' + previous['migrationTaskId']) if previous.get('migrationTaskId') else
                    await request('POST', '/api/migration-tasks', json={'sourceAssetIds': [asset['assetId']],
                    'goal': '将现有本地容量检查 Skill 和 CLI 工具整理为可交付版本，修复边界：capacity>=people 应 ACCEPT，capacity<people 应 REJECT。保持 CLI 形式；不创建 MCP 服务，不新建 Runtime。'}))
                identifier = migration['id']
                configured_environment = (migration.get('configuration') or {}).get('environmentId')
                migration_environment = (await request('GET', '/api/environments/' + configured_environment) if configured_environment else
                    await request('POST', '/api/environments', json={'name': 'Isolated concurrent migration Launcher',
                        'type': 'runtime_launcher', 'runtimeType': 'openjiuwen', 'baseUrl': f'http://127.0.0.1:{migration_port}/'}))
                evidence['migrationTaskId'] = identifier
                (directory / 'verification.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding='utf-8')
                await request('PUT', f'/api/migration-tasks/{identifier}/configuration', json={'environmentId': migration_environment['environmentId'],
                'modelId': model_id, 'timeoutMs': 240000, 'harnessTools': ['read_file', 'glob', 'list_files', 'bash']})
                await request('PUT', f'/api/migration-tasks/{identifier}/suite', json=migration.get('suite') or suite)
                evaluated = any(run['status'] == 'PASSED' and run['candidateId'] == migration.get('currentCandidateId')
                    and run.get('configurationCurrent') for run in migration['runs'])
                reviewed = evaluated and any(review.get('assessmentMode') == 'GOAL' and review['decision']['selected']
                    and any(run['id'] == review['candidateRunId'] and run['candidateId'] == migration.get('currentCandidateId')
                        and run.get('configurationCurrent') for run in migration['runs']) for review in migration.get('effectReviews', []))
                instruction = ('效果评测已有通过记录，保留当前代码和结果。请完成剩余基础验证：用隔离命令真实运行当前 CLI 的三个边界，登记 CLI 交付入口（services 为空），并委派 migration_delivery_reviewer 独立审查基础验证是否覆盖本任务目标。只有登记交付入口或修改文件导致当前版本缺少适用评测时才复测。记录方案和结论后交付。'
                    if evaluated else
                    '继续完成原任务，先检查上次工作草稿，不丢弃已完成的代码。保持本地纯计算 CLI，修复容量等于人数的边界，同时更新 Skill 和实际源码。完成真实基础测试并委派独立交付审查；使用现有 Runtime 和给定测试集运行单次效果验证。平台已将单次评测和持续优化工具分开，单次评测调用 request_development_evaluation，参数为 {}；本任务未要求持续优化，无需编造优化目标、预算或基线。完成后交付代码和证据。已有执行环境可用，无需 Builder。')
                instruction += ' 本测试场景的业务目标明确为 capacity>=people 时 ACCEPT，capacity<people 时 REJECT；原 Skill 中的严格大于正是需要修复的缺陷，连同源码一起修复。使用 query_delivery_tools 核对实际登记；尚未登记时按已确定的 CLI 方案直接登记。'
                instruction += ('当前版本已有适用的独立目标 Review，保留它，不重复审查。' if reviewed else
                    '当前版本评测通过后，调用 request_effect_review，只传 candidate_run_id，对本次测试集是否达到用户目标做独立审查，不需要或编造原工程基线。') + '完成完整验收交付。'
                if migration.get('currentCandidateId'):
                    instruction += '这是接续当前候选版本，不是从原工程重新开始：优先查询现有评测与登记，仅补齐缺失或已失效的验证和审查。无真实缺陷时不再修改或重新登记，已有命令回执可交给独立审查核实。'
                last = (migration.get('attempts') or [{}])[-1]
                if last.get('status') == 'WAITING':
                    conversation = await request('GET', f'/api/migration-tasks/{identifier}/conversation')
                    interaction = next(item for item in conversation['interactions'] if item['interactionId'] in last['waitingInteractionIds'])
                    payload = interaction['request'].get('value', interaction['request'])
                    questions = payload.get('questions', [])
                    # Only answer decisions already defined by this fixture's
                    # explicit business contract. Unknown decisions stay visible.
                    if not questions or any(not any(word in item['question'] for word in ('登记', 'capacity', '容量', '边界')) for item in questions):
                        raise RuntimeError('Verification requires an unanticipated user decision: ' + str(questions))
                    await request('POST', f'/api/migration-tasks/{identifier}/conversation/answer', json={
                        'key': 'real-http-answer-' + str(time.time_ns()), 'attemptId': last['id'], 'interactionId': interaction['interactionId'],
                        'answers': {item['question']: instruction for item in questions}})
                else:
                    await request('POST', f'/api/migration-tasks/{identifier}/conversation/message', json={'key': 'real-http-migration-' + str(time.time_ns()),
                        'text': instruction})
                task = await settle('/api/migration-tasks/' + identifier, {'COMPLETED', 'WAITING', 'FAILED', 'CANCELLED', 'INTERRUPTED'})
                (directory / 'migration-task.json').write_text(json.dumps(task, ensure_ascii=False, indent=2), encoding='utf-8')
                if not task.get('currentCandidateId'):
                    raise RuntimeError('Real main Agent did not publish a candidate; task retained for diagnosis')
                evidence.update(migrationTaskId=identifier)
                evidence['checks'].append('main-agent/http-session/code-edit/git-publication')
                if not any(run['status'] == 'PASSED' and run['candidateId'] == task['currentCandidateId'] and run.get('configurationCurrent') for run in task['runs']):
                    raise RuntimeError('Main Agent did not complete passing effect evaluation for the current files')
                if not task.get('basicDelivery', {}).get('coversTaskScope'):
                    raise RuntimeError('Main Agent did not complete independent basic validation review for the current files')
                evidence['checks'].append('main-agent/basic-validation/effect-evaluation/independent-review')
                if not task.get('deliveryVerification') or not any(review.get('assessmentMode') == 'GOAL' and review['decision']['selected']
                        for review in task.get('effectReviews', [])):
                    raise RuntimeError('Single-result independent goal Review did not reach verified delivery')
                evidence['checks'].append('single-result/goal-review/verified-delivery')
                exported = await client.get(f'/api/migration-tasks/{identifier}/export', params={'verified': 'true'})
                if not exported.is_success:
                    raise RuntimeError('Current reviewed migration package could not be delivered: ' + exported.text[:500])
                (directory / 'migration-delivery.zip').write_bytes(exported.content)
                with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
                    entries = [name for name in archive.namelist() if name.startswith('package/') and not name.endswith('/')]
                    cli = next((name for name in entries if name.endswith('scripts/check_capacity.py')), None)
                    if cli is None or archive.read(cli) == script.encode():
                        raise RuntimeError('Delivered package did not contain the actual repaired CLI')
                    from runtime.project import execute_project_command
                    with TemporaryDirectory(prefix='delivered-cli-', dir=directory) as extracted:
                        base = Path(extracted).resolve()
                        for name in entries:
                            target = (base / name.removeprefix('package/')).resolve()
                            if not target.is_relative_to(base):
                                raise RuntimeError('Delivery contains an unsafe archive member')
                            target.parent.mkdir(parents=True, exist_ok=True)
                            target.write_bytes(archive.read(name))
                        for capacity, expected in ((4, 'ACCEPT'), (3, 'REJECT'), (5, 'ACCEPT')):
                            receipt = await execute_project_command(base, ['python', cli.removeprefix('package/'), str(capacity), '4'])
                            if receipt['status'] != 'COMPLETED' or receipt['output'].strip() != expected:
                                raise RuntimeError('Delivered CLI failed its actual boundary check: ' + str(receipt))
                evidence['checks'].append('delivered-cli/three-real-boundaries')
                evidence['checks'].append('reviewed-migration/current-code/download')
            # The two public business entrances share the same API/Agent host.
            # Separate standard Launchers avoid the local Worker's two-instance
            # limit while their real model and evidence work overlaps.
            async with asyncio.TaskGroup() as group:
                if '--optimization-only' not in sys.argv:
                    group.create_task(verify_migration())
                if '--migration-only' not in sys.argv:
                    group.create_task(verify_optimization())
            evidence.update(completed=True)
            print(json.dumps({'passed': True, **evidence}, ensure_ascii=False), flush=True)
        finally:
            evidence['checks'] = list(dict.fromkeys(evidence['checks']))
            (directory / 'verification.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding='utf-8')
            for process in processes:
                if process.returncode is None:
                    process.stdin.write(b'stop\n')
                    await process.stdin.drain()
            for process in processes:
                try:
                    await asyncio.wait_for(process.wait(), 50)
                except asyncio.TimeoutError:
                    process.kill()
                    await process.wait()
            for stream in streams:
                stream.close()


if __name__ == '__main__':
    asyncio.run(main())
