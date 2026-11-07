"""Check the project's SDK pin before importing OpenJiuwen or starting a model/session."""
import json
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
import re
import sys


def check_environment():
    source = str(Path(__file__).resolve().parents[2] / 'src')
    if source not in sys.path:
        sys.path.insert(0, source)
    # tomllib is in the standard library of every supported project interpreter.
    if sys.version_info < (3, 11):
        raise RuntimeError('OpenJiuwen project requires Python 3.11 or newer; run pnpm setup:openjiuwen.')
    import tomllib
    project = tomllib.loads(Path(__file__).with_name('pyproject.toml').read_text(encoding='utf-8'))['project']
    python_range = re.fullmatch(r'>=(\d+)\.(\d+)(?:\.(\d+))?,<(\d+)\.(\d+)', project['requires-python'])
    if not python_range:
        raise RuntimeError('Unsupported Python range in the project manifest')
    low_major, low_minor, low_patch, high_major, high_minor = python_range.groups()
    pins = [d.removeprefix('openjiuwen==') for d in project['dependencies'] if d.startswith('openjiuwen==')]
    if len(pins) != 1:
        raise RuntimeError('The project must declare exactly one pinned OpenJiuwen version')
    try:
        installed = version('openjiuwen')
    except PackageNotFoundError:
        installed = 'not installed'
    supported = (int(low_major), int(low_minor), int(low_patch or 0)) <= sys.version_info[:3] < (int(high_major), int(high_minor), 0)
    report = {'python': sys.executable, 'pythonVersion': '.'.join(map(str, sys.version_info[:3])),
              'openjiuwen': installed, 'expectedOpenjiuwen': pins[0], 'requiredPython': project['requires-python']}
    if not supported or installed != pins[0]:
        raise RuntimeError(
            f"Wrong OpenJiuwen environment: Python {report['pythonVersion']} / OpenJiuwen {installed}; "
            f"expected Python {project['requires-python']} / OpenJiuwen {pins[0]}. "
            'Use pnpm python:openjiuwen or run pnpm setup:openjiuwen; do not use system Python.')
    return report


if __name__ == '__main__':
    try:
        print(json.dumps({'ok': True, **check_environment()}))
    except (RuntimeError, OSError, ValueError) as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
        raise SystemExit(1)
