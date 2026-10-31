"""Offline, streaming backup. Restores only into a new/empty destination."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import zipfile


def safe_name(name):
    parts = name.split('/')
    return (not PurePosixPath(name).is_absolute() and '\\' not in name and ':' not in name
            and all(p not in ('', '.', '..') for p in parts))


def digest(stream):
    value = hashlib.sha256()
    while block := stream.read(1024 * 1024):
        value.update(block)
    return value.hexdigest()


def create(archive, data, config=None, config_files=None):
    data, archive = data.resolve(), archive.resolve()
    config = config.resolve() if config else None
    files = [Path(f) for f in (config_files or [])]
    if not data.is_dir() or (config and not config.is_dir()) or (not config and not files):
        raise ValueError('DATA_AND_CONFIG_DIRECTORIES_REQUIRED')
    if any(f.is_symlink() or not f.is_file() for f in files):
        raise ValueError('REGULAR_CONFIG_FILES_REQUIRED')
    if len({f.name for f in files}) != len(files) or (config and files):
        raise ValueError('AMBIGUOUS_CONFIG_FILES')
    if archive == data or data in archive.parents or (config and config in archive.parents) or archive in [f.resolve() for f in files]:
        raise ValueError('BACKUP_MUST_BE_OUTSIDE_SOURCE_DIRECTORIES')
    # Supervisors remove state files only after their child exits. A leftover
    # state must be investigated by the operator, never silently backed up live.
    if (data / 'processes').exists() and list((data / 'processes').glob('*.json')):
        raise ValueError('STOP_SERVICES_AND_RESOLVE_STALE_PROCESS_STATE_FIRST')
    manifest = {'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'files': {}}
    fd = os.open(archive, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as output, zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as zipped:
        for prefix, root in [('data', data)] + ([('config', config)] if config else []):
            for file in sorted(root.rglob('*')):
                if file.is_symlink():
                    raise ValueError('BACKUP_SYMLINK_NOT_SUPPORTED')
                if not file.is_file() or (prefix == 'data' and file.relative_to(root).parts[0] == 'processes'):
                    continue
                name = prefix + '/' + file.relative_to(root).as_posix()
                if not safe_name(name):
                    raise ValueError('UNSAFE_BACKUP_PATH')
                zipped.write(file, name)
                with file.open('rb') as source:
                    manifest['files'][name] = digest(source)
        for file in files:
            name = 'config/' + file.name
            if not safe_name(name):
                raise ValueError('UNSAFE_BACKUP_PATH')
            zipped.write(file, name)
            with file.open('rb') as source:
                manifest['files'][name] = digest(source)
        zipped.writestr('manifest.json', json.dumps(manifest))
    verify(archive)


def verify(archive):
    with zipfile.ZipFile(archive) as zipped:
        names = zipped.namelist()
        if len(names) != len(set(names)) or any(not safe_name(n) for n in names):
            raise ValueError('UNSAFE_OR_DUPLICATE_ARCHIVE_PATH')
        manifest = json.loads(zipped.read('manifest.json'))
        if set(names) != {'manifest.json', *manifest['files']}:
            raise ValueError('MANIFEST_CONTENT_MISMATCH')
        for name, expected in manifest['files'].items():
            if name.split('/')[0] not in ('data', 'config'):
                raise ValueError('UNEXPECTED_ARCHIVE_ROOT')
            with zipped.open(name) as stream:
                if digest(stream) != expected:
                    raise ValueError('BACKUP_DIGEST_MISMATCH')
    return manifest


def restore(archive, destination):
    manifest = verify(archive)
    if destination.is_symlink():
        raise ValueError('RESTORE_SYMLINK_NOT_SUPPORTED')
    destination = destination.resolve()
    if destination.exists() and (not destination.is_dir() or any(destination.iterdir())):
        raise ValueError('RESTORE_DESTINATION_MUST_BE_EMPTY')
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    with zipfile.ZipFile(archive) as zipped:
        for name in manifest['files']:
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with zipped.open(name) as source, target.open('xb') as output:
                while block := source.read(1024 * 1024):
                    output.write(block)
            target.chmod(0o600)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['create', 'verify', 'restore'])
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--data', type=Path)
    parser.add_argument('--config', type=Path)
    parser.add_argument('--config-file', type=Path, action='append')
    parser.add_argument('--destination', type=Path)
    args = parser.parse_args()
    try:
        if args.command == 'create':
            if not args.data or not (args.config or args.config_file):
                raise ValueError('DATA_AND_CONFIG_REQUIRED')
            create(args.archive, args.data, args.config, args.config_file)
        elif args.command == 'verify':
            verify(args.archive)
        else:
            if not args.destination:
                raise ValueError('DESTINATION_REQUIRED')
            restore(args.archive, args.destination)
        print(json.dumps({'status': 'PASSED', 'operation': args.command}))
    except Exception as error:
        # Archive names/content and configuration values never enter logs.
        code = str(error) if isinstance(error, ValueError) and str(error).replace('_', '').isupper() else type(error).__name__
        print(json.dumps({'status': 'FAILED', 'code': code}))
        raise SystemExit(1)


if __name__ == '__main__':
    main()
