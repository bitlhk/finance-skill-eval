"""Framework-neutral project execution. Operator supplies the image; agent supplies argv.

Only a read-only project copy enters the container. Build outputs stay ephemeral;
source adaptations must use the shared candidate file tools.
"""
import asyncio
import os
from pathlib import Path
import uuid


def snapshot_digest(root):
    from bundle_agent import collect_candidate
    from bundle_runtime import files_digest
    import base64
    return files_digest({name: base64.b64decode(content) for name, content in collect_candidate(root).items()})


def execution_arguments(root, image, name, command, cwd):
    try:
        from .workspace_paths import analysis_path, check_analysis_tree
    except ImportError:
        from workspace_paths import analysis_path, check_analysis_tree
    if not isinstance(command, list) or not command or len(command) > 100 or any(
            not isinstance(arg, str) or '\0' in arg or len(arg) > 8000 for arg in command):
        raise ValueError('command must be a nonempty argv array')
    check_analysis_tree(root)
    directory = analysis_path(root, str(root / cwd))
    if not directory.is_dir():
        raise ValueError('cwd must be an existing project directory')
    relative = directory.relative_to(root.resolve()).as_posix()
    if not image or image.startswith('-') or any(char.isspace() for char in image):
        raise ValueError('Operator image is invalid')
    return ['docker', 'run', '--rm', '--pull=never', '--name', name, '--network=none',
            '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
            '--pids-limit=128', '--memory=1g', '--cpus=1', '--user=65534:65534',
            '--tmpfs=/tmp:rw,exec,size=536870912,mode=1777',
            '--mount', f'type=bind,source={root.resolve()},target=/input,readonly',
            '--entrypoint=sh', image, '-c',
            'mkdir /tmp/project && cp -R /input/. /tmp/project/ && cd "/tmp/project/$1" && shift && exec "$@"',
            'project-command', relative, *command]


async def execute_project_command(root, command, cwd='.', timeout_seconds=60, *, container_name=None):
    root = Path(root).resolve()
    receipt = dict(command=command, cwd=cwd, status='UNAVAILABLE', exitCode=None,
                   output='', snapshotDigest=snapshot_digest(root))
    image = os.environ.get('FINANCE_EVAL_PROJECT_EXECUTION_IMAGE', '').strip()
    if not image:
        receipt['output'] = '管理员尚未配置工程执行镜像；已保留调查与适配，不能声明运行通过。'
        return receipt
    name = container_name or 'finance-project-' + uuid.uuid4().hex
    if not name.startswith('finance-project-') or not all(c.isalnum() or c == '-' for c in name):
        raise ValueError('Invalid container name')
    argv = execution_arguments(root, image, name, command, cwd)
    environment = {key: os.environ[key] for key in ('PATH', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP') if key in os.environ}
    process = None
    output = bytearray()
    truncated = False

    async def drain(stream):
        nonlocal truncated
        while chunk := await stream.read(4096):
            remaining = 16000 - len(output)
            output.extend(chunk[:max(remaining, 0)])
            truncated |= len(chunk) > remaining

    try:
        process = await asyncio.create_subprocess_exec(*argv, env=environment,
            stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        async def complete():
            await drain(process.stdout)
            return await process.wait()
        receipt['exitCode'] = await asyncio.wait_for(complete(), max(1, min(int(timeout_seconds), 120)))
        receipt['status'] = 'COMPLETED' if receipt['exitCode'] == 0 else 'FAILED'
    except asyncio.TimeoutError:
        receipt['status'] = 'TIMEOUT'
    except OSError as error:
        receipt['output'] = '工程执行环境不可用：' + str(error)
    finally:
        if process is not None:
            # Remove the named container even if the client is cancelled or timed out.
            async def cleanup():
                child = await asyncio.create_subprocess_exec('docker', 'rm', '-f', name, env=environment,
                    stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
                try:
                    await asyncio.wait_for(child.wait(), 10)
                finally:
                    if child.returncode is None:
                        child.kill()
                        await child.wait()
            try:
                await asyncio.shield(cleanup())
            finally:
                if process.returncode is None:
                    process.kill()
                    await process.wait()
    receipt['output'] += output.decode('utf-8', errors='replace') + ('\n[output truncated]' if truncated else '')
    return receipt


def build_project_command_tool(root, receipts):
    from openjiuwen.core.foundation.tool import LocalFunction, ToolCard

    async def run(command, cwd='.', timeout_seconds=60):
        result = await execute_project_command(root, command, cwd, timeout_seconds)
        receipts.append(result)
        return result

    return LocalFunction(ToolCard(id='project-command', name='run_project_command',
        description='在管理员提供的隔离镜像里运行工程命令，返回真实执行回执。command 为参数数组，cwd 相对 candidate。每次使用临时副本，文件修改不带回；源码适配请用文件工具。无网络与宿主凭证，缺少依赖如实报告。',
        input_params={'type': 'object', 'properties': {
            'command': {'type': 'array', 'items': {'type': 'string'}},
            'cwd': {'type': 'string'}, 'timeout_seconds': {'type': 'integer'}}, 'required': ['command']}), run)


if __name__ == '__main__':
    import json
    import sys
    import tempfile
    from contextlib import nullcontext
    request = json.loads(sys.stdin.read(2_000_000))
    provided = request.get('workspace')
    if provided and (Path(provided).resolve().parent != Path(tempfile.gettempdir()).resolve() or not Path(provided).name.startswith('finance-verifier-')):
        raise ValueError('Invalid verification workspace')
    with (nullcontext(provided) if provided else tempfile.TemporaryDirectory(prefix='finance-verifier-')) as directory:
        root = Path(directory)
        (root / 'verify.py').write_text(request['script'], encoding='utf-8')
        (root / 'evidence.json').write_text(json.dumps(request['resources'], ensure_ascii=False), encoding='utf-8')
        receipt = asyncio.run(execute_project_command(root, ['python', 'verify.py'],
            timeout_seconds=request.get('timeoutSeconds', 60), container_name=request.get('containerName')))
        print(json.dumps(receipt, ensure_ascii=False))
