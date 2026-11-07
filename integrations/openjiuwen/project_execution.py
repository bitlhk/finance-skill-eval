"""Framework-neutral project execution. Operator supplies the image; agent supplies argv.

Only a read-only project copy enters the container. Build outputs stay ephemeral;
source adaptations must use the shared candidate file tools.
"""
import asyncio
import base64
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import uuid


def snapshot_digest(root):
    try:
        from .bundle_agent import collect_candidate
        from .bundle_runtime import files_digest
    except ImportError:
        from bundle_agent import collect_candidate
        from bundle_runtime import files_digest
    import base64
    return files_digest({name: base64.b64decode(content) for name, content in collect_candidate(root).items()})


def execution_arguments(root, image, name, command, cwd, *, mount_root=None):
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
            '--read-only', '--cap-drop=ALL', '--cap-add=DAC_OVERRIDE', '--cap-add=CHOWN',
            '--cap-add=SETUID', '--cap-add=SETGID', '--security-opt=no-new-privileges',
            '--pids-limit=128', '--memory=1g', '--cpus=1', '--user=0:0',
            '--env=HOME=/tmp/project/.home', '--env=XDG_CACHE_HOME=/tmp/project/.cache',
            '--env=XDG_DATA_HOME=/tmp/project/.local/share',
            '--tmpfs=/tmp:rw,exec,size=536870912,mode=1777',
            '--mount', f'type=bind,source={mount_root or root.resolve()},target=/input,readonly',
            '--entrypoint=sh', image, '-c',
            'mkdir /tmp/project && cp -R /input/. /tmp/project/ && '
            'chown -R 65534:65534 /tmp/project && cd "/tmp/project/$1" && shift && '
            'exec setpriv --reuid=65534 --regid=65534 --clear-groups '
            '--bounding-set=-all --inh-caps=-all --ambient-caps=-all -- "$@"',
            'project-command', relative, *command]


async def docker_driver(root, environment):
    """Resolve an operator-selected WSL Docker without changing container policy."""
    distribution = os.environ.get('FINANCE_EVAL_DOCKER_WSL_DISTRIBUTION', '').strip()
    if not distribution:
        return ['docker'], None
    user = os.environ.get('FINANCE_EVAL_DOCKER_WSL_USER', '').strip()
    if os.name != 'nt' or not re.fullmatch(r'[\w][\w. -]{0,127}', distribution) or (user and not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.-]{0,63}', user)):
        raise ValueError('WSL Docker configuration is invalid')
    prefix = ['wsl.exe', '--distribution', distribution, *(['--user', user] if user else []), '--']
    # WSL reparses command arguments. The bridge sends the argv as data over
    # stdin, preserving spaces, quotes and shell metacharacters exactly.
    converter = await spawn_wsl(prefix, ['wslpath', '-a', str(root).replace('\\', '/')], environment,
                                asyncio.subprocess.PIPE, asyncio.subprocess.PIPE)
    try:
        output, _ = await asyncio.wait_for(converter.communicate(), 15)
    except asyncio.TimeoutError:
        converter.kill()
        await converter.wait()
        raise RuntimeError('WSL path conversion timed out') from None
    mount = output.decode('utf-8', errors='strict').strip()
    if converter.returncode != 0 or not mount.startswith('/') or any(char in mount for char in (',', '\n', '\r', '\0')):
        raise ValueError('WSL cannot access the project directory')
    return [*prefix, 'docker'], mount


async def spawn_wsl(prefix, arguments, environment, stdout, stderr):
    payload=base64.b64encode(json.dumps(arguments,ensure_ascii=True).encode('ascii')).decode('ascii')
    program=('import base64,json,os\nargs=json.loads(base64.b64decode("'+payload+'"))\nos.execvp(args[0],args)\n').encode('ascii')
    child=await asyncio.create_subprocess_exec(*prefix,'python3','-',env=environment,stdin=asyncio.subprocess.PIPE,
        stdout=stdout,stderr=stderr)
    try:
        child.stdin.write(program)
        await child.stdin.drain()
        child.stdin.close()
        child.stdin=None
    except BaseException:
        if child.returncode is None:
            child.kill()
            await child.wait()
        raise
    return child


async def remove_project_container(driver, environment, name):
    child = (await spawn_wsl(driver[:-1], ['docker', 'rm', '-f', name], environment,
                             asyncio.subprocess.DEVNULL, asyncio.subprocess.DEVNULL)
             if len(driver)>1 else await asyncio.create_subprocess_exec(*driver, 'rm', '-f', name, env=environment,
                 stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL))
    try:
        await asyncio.wait_for(child.wait(), 10)
    finally:
        if child.returncode is None:
            child.kill()
            await child.wait()


async def execute_project_command(root, command, cwd='.', timeout_seconds=60, *, container_name=None):
    # Models sometimes send explicit null for optional arguments. Treat it as
    # omission so even an unavailable execution has a valid, truthful receipt.
    cwd = '.' if cwd is None else cwd
    timeout_seconds = 60 if timeout_seconds is None else timeout_seconds
    if not isinstance(cwd, str) or not isinstance(command, list) or not command or any(not isinstance(arg, str) for arg in command):
        raise ValueError('command must be a nonempty string array and cwd must be a string')
    if isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, int):
        raise ValueError('timeout_seconds must be an integer')
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
    environment = {key: os.environ[key] for key in ('PATH', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP') if key in os.environ}
    driver = ['docker']
    process = None
    staged = None
    output = bytearray()
    truncated = False

    async def drain(stream):
        nonlocal truncated
        while chunk := await stream.read(4096):
            remaining = 16000 - len(output)
            output.extend(chunk[:max(remaining, 0)])
            truncated |= len(chunk) > remaining

    try:
        execution_root = root
        if os.environ.get('TMPDIR'):
            # Container volumes need not exist at the same host path. The
            # deployment mounts TMPDIR at an identical path on both sides.
            # Stage only frozen project bytes there, never credentials/state.
            try:
                from .workspace_paths import check_analysis_tree
            except ImportError:
                from workspace_paths import check_analysis_tree
            check_analysis_tree(root)
            staged = tempfile.TemporaryDirectory(prefix='finance-project-command-', dir=os.environ['TMPDIR'])
            execution_root = Path(staged.name) / 'project'
            await asyncio.to_thread(shutil.copytree, root, execution_root)
            if snapshot_digest(execution_root) != receipt['snapshotDigest']:
                raise ValueError('Project changed while preparing execution')
        driver, mount_root = await docker_driver(execution_root, environment)
        arguments = execution_arguments(execution_root, image, name, command, cwd, mount_root=mount_root)
        argv = [*driver, *arguments[1:]]
        process = (await spawn_wsl(driver[:-1],argv[len(driver)-1:],environment,asyncio.subprocess.PIPE,asyncio.subprocess.STDOUT)
            if len(driver)>1 else await asyncio.create_subprocess_exec(*argv, env=environment,
                stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT))
        async def complete():
            await drain(process.stdout)
            return await process.wait()
        receipt['exitCode'] = await asyncio.wait_for(complete(), max(1, min(int(timeout_seconds), 120)))
        receipt['status'] = 'COMPLETED' if receipt['exitCode'] == 0 else 'FAILED'
    except asyncio.TimeoutError:
        receipt['status'] = 'TIMEOUT'
    except (OSError, ValueError, RuntimeError, UnicodeError) as error:
        receipt['output'] = '工程执行环境不可用：' + str(error)
    finally:
        try:
            if process is not None:
                # Remove the named container even if the client is cancelled or timed out.
                try:
                    await asyncio.shield(remove_project_container(driver, environment, name))
                finally:
                    if process.returncode is None:
                        process.kill()
                        await process.wait()
        finally:
            if staged is not None:
                staged.cleanup()
    receipt['output'] += output.decode('utf-8', errors='replace') + ('\n[output truncated]' if truncated else '')
    return receipt


def verifier_result(receipt):
    """Convert an isolated verifier receipt to its JSON result without hiding failures."""
    if receipt['status'] != 'COMPLETED':
        return receipt
    try:
        def reject_nonfinite(value):
            raise ValueError('Non-finite JSON number: ' + value)
        result = json.loads(receipt['output'], parse_constant=reject_nonfinite)
    except (ValueError, TypeError):
        return {**receipt, 'status': 'INVALID_OUTPUT', 'output': 'Verifier did not return valid JSON'}
    return {**receipt, 'result': result}


def build_project_command_tool(root, receipts):
    from openjiuwen.core.foundation.tool import LocalFunction, ToolCard

    async def run(command, cwd='.', timeout_seconds=60):
        result = await execute_project_command(root, command, cwd, timeout_seconds)
        result['receiptId'] = 'project-check-' + uuid.uuid4().hex
        receipts.append(result)
        return result

    return LocalFunction(ToolCard(id='project-command', name='run_project_command',
        description='在管理员提供的 Linux 隔离镜像里运行工程命令，返回真实执行回执。command 为参数数组，cwd 相对 candidate；候选文件复制到 /tmp/project，命令中的文件用候选内相对路径，如 ["python","scripts/check.py"]，不能用宿主 Windows 路径或 candidate/ 前缀。每次使用临时副本，文件修改不带回；源码适配请用文件工具。无网络与宿主凭证，缺少依赖如实报告。',
        input_params={'type': 'object', 'properties': {
            'command': {'type': 'array', 'items': {'type': 'string'}},
            'cwd': {'type': 'string'}, 'timeout_seconds': {'type': 'integer'}}, 'required': ['command']}), run)


if __name__ == '__main__':
    import sys
    import tempfile
    from contextlib import nullcontext
    request = json.loads(sys.stdin.read(2_000_000))
    provided = request.get('workspace')
    if provided and (Path(provided).resolve().parent != Path(tempfile.gettempdir()).resolve() or not Path(provided).name.startswith('finance-verifier-')):
        raise ValueError('Invalid verification workspace')
    if request.get('action') == 'cleanup':
        name = request.get('containerName')
        if not provided or not isinstance(name, str) or not re.fullmatch(r'finance-project-[a-f0-9-]{36}', name):
            raise ValueError('Invalid verification cleanup request')
        async def cleanup_verifier():
            environment = {key: os.environ[key] for key in ('PATH', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP') if key in os.environ}
            driver, _ = await docker_driver(Path(provided), environment)
            await remove_project_container(driver, environment, name)
        asyncio.run(cleanup_verifier())
        sys.exit(0)
    with (nullcontext(provided) if provided else tempfile.TemporaryDirectory(prefix='finance-verifier-')) as directory:
        root = Path(directory)
        (root / 'verify.py').write_text(request['script'], encoding='utf-8')
        (root / 'evidence.json').write_text(json.dumps(request['resources'], ensure_ascii=False), encoding='utf-8')
        receipt = asyncio.run(execute_project_command(root, ['python', 'verify.py'],
            timeout_seconds=request.get('timeoutSeconds', 60), container_name=request.get('containerName')))
        print(json.dumps(verifier_result(receipt), ensure_ascii=False))
