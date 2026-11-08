from pathlib import Path
import os


def _comparison_path(path: Path) -> Path:
    value = str(path)
    if os.name == 'nt':
        if value.startswith('\\\\?\\UNC\\'):
            value = '\\\\' + value[8:]
        elif value.startswith('\\\\?\\'):
            value = value[4:]
    return Path(value)

def analysis_path(root: Path, value: str = "") -> Path:
    if not isinstance(value, str) or "\x00" in value:
        raise ValueError("ANALYSIS_PATH_INVALID")
    root = root.resolve()
    candidate = Path(value) if value else root
    if not candidate.is_absolute():
        candidate = root / candidate
    target = candidate.resolve()
    comparable_root, comparable_target = _comparison_path(root), _comparison_path(target)
    if comparable_target != comparable_root and comparable_root not in comparable_target.parents:
        raise ValueError("ANALYSIS_PATH_OUTSIDE_WORKSPACE")
    # Keep the workspace's long-path spelling for SDK filesystem operations,
    # while accepting the equivalent ordinary Windows path from the model.
    return root / comparable_target.relative_to(comparable_root)


def candidate_path(root: Path, value: str = "") -> Path:
    """Use the reader's candidate/... paths while keeping bare edit paths.

    source/ and task/ name the workspace's protected roots, never writable
    subdirectories inferred inside the candidate. Absolute paths retain the
    same candidate boundary, including resolution of traversal and links.
    """
    if not isinstance(value, str) or '\x00' in value:
        raise ValueError('ANALYSIS_PATH_INVALID')
    path = Path(value)
    if not path.is_absolute() and path.parts and path.parts[0] in ('candidate', 'source', 'task'):
        return analysis_path(root, str(analysis_path(root.parent, value)))
    return analysis_path(root, value)


def check_analysis_tree(root: Path) -> None:
    # Uploaded archives cannot create links. Fail closed if another writer has
    # nevertheless introduced one before SDK traversal; never follow it.
    for item in root.rglob("*"):
        if item.is_symlink() or not (item.is_file() or item.is_dir()):
            raise ValueError("ANALYSIS_WORKSPACE_SPECIAL_FILE")
