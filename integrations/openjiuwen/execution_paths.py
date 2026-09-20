"""Independent execution workspace and loaded Skill location."""
from pathlib import Path
import tempfile


def execution_paths(stack, config, skill):
    configured_workspace = config.get('workspaceDirectory')
    if configured_workspace:
        workspace = Path(configured_workspace).resolve()
        workspace.mkdir(parents=True, exist_ok=True)
    else:
        workspace_root = config.get('workspaceRoot')
        if workspace_root:
            Path(workspace_root).mkdir(parents=True, exist_ok=True)
        workspace = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix='finance-workspace-', dir=workspace_root))).resolve()
    configured_skill = config.get('skillDirectories', {}).get((skill or {}).get('artifactSha256'))
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
            target.write_text(content, encoding='utf-8')
    return workspace, skill_path


def read_execution_file(path, workspace, skill_path):
    target = Path(path)
    target = (workspace / target).resolve() if not target.is_absolute() else target.resolve()
    if not any(root == target or root in target.parents for root in (workspace, skill_path)):
        raise ValueError('File is outside the workspace and loaded Skill')
    with target.open('r', encoding='utf-8') as stream:
        return target, stream.read(60000)
