"""Independent execution workspace and loaded Skill location."""
from pathlib import Path
import hashlib
import tempfile
import base64


def workspace_files_digest(files):
    if not files:
        return None
    digest = hashlib.sha256()
    for item in sorted(files, key=lambda value: value['path']):
        digest.update(item['path'].encode('utf-8'))
        digest.update(b'\0')
        digest.update(item['content'].encode('utf-8'))
        digest.update(b'\0')
    return digest.hexdigest()


def execution_paths(stack, config, skill, workspace_files=None):
    workspace_files = workspace_files or []
    configured_workspace = None if (skill or {}).get('bundleMembers') else config.get('workspaceDirectory')
    if configured_workspace and not workspace_files:
        workspace = Path(configured_workspace).resolve()
        workspace.mkdir(parents=True, exist_ok=True)
    else:
        workspace_root = config.get('workspaceRoot')
        if workspace_root:
            Path(workspace_root).mkdir(parents=True, exist_ok=True)
        workspace = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix='finance-workspace-', dir=workspace_root))).resolve()
    for item in workspace_files:
        target = (workspace / item['path']).resolve()
        if workspace not in target.parents:
            raise ValueError('Unsafe test data path')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(item['content'], encoding='utf-8')
    configured_skill = None if (skill or {}).get('bundleMembers') else config.get('skillDirectories', {}).get((skill or {}).get('artifactSha256'))
    skill_path = Path(configured_skill).resolve() if configured_skill else Path(stack.enter_context(tempfile.TemporaryDirectory(prefix='finance-skill-'))).resolve()
    for name, content in (skill or {}).get('files', {}).items():
        target = (skill_path / name.replace('\\', '/')).resolve()
        if skill_path not in target.parents:
            raise ValueError('Unsafe Skill package path')
        if configured_skill:
            if not target.is_file() or target.read_text(encoding='utf-8') != content:
                raise ValueError('Configured Skill does not match the loaded artifact')
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            if (skill or {}).get('bundleMembers'):
                target.write_bytes(content.encode('utf-8'))
            else:
                target.write_text(content, encoding='utf-8')
    for name, encoded in (skill or {}).get('binaryFiles', {}).items():
        target = (skill_path / name).resolve()
        if skill_path not in target.parents:
            raise ValueError('Unsafe binary resource path')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(base64.b64decode(encoded, validate=True))
    return workspace, skill_path, workspace_files_digest(workspace_files)


def read_execution_file(path, workspace, skill_path):
    target = Path(path)
    target = (workspace / target).resolve() if not target.is_absolute() else target.resolve()
    if not any(root == target or root in target.parents for root in (workspace, skill_path)):
        raise ValueError('File is outside the workspace and loaded Skill')
    with target.open('r', encoding='utf-8') as stream:
        return target, stream.read(60000)
