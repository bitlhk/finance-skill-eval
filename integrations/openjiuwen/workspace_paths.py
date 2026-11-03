from pathlib import Path

def analysis_path(root: Path, value: str = "") -> Path:
    if not isinstance(value, str) or "\x00" in value:
        raise ValueError("ANALYSIS_PATH_INVALID")
    candidate = Path(value) if value else root
    if not candidate.is_absolute():
        candidate = root / candidate
    target = candidate.resolve()
    if target != root and root not in target.parents:
        raise ValueError("ANALYSIS_PATH_OUTSIDE_WORKSPACE")
    return target


def check_analysis_tree(root: Path) -> None:
    # Uploaded archives cannot create links. Fail closed if another writer has
    # nevertheless introduced one before SDK traversal; never follow it.
    for item in root.rglob("*"):
        if item.is_symlink() or not (item.is_file() or item.is_dir()):
            raise ValueError("ANALYSIS_WORKSPACE_SPECIAL_FILE")
