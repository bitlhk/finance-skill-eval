"""Recover evaluation jobs in the existing runs directory after a restart."""
from datetime import datetime, timezone

from storage.tasks import filesystem_path, read_json, write_json
from filelock import FileLock
from copy import deepcopy


def execute(request):
    if request['action'] not in ('initialize', 'save'):
        raise ValueError('Unknown evaluation job action')
    directory = filesystem_path(request['path'])
    if not directory.is_absolute():
        raise ValueError('Storage path must be absolute')
    directory.mkdir(parents=True, exist_ok=True)
    if request['action'] == 'save':
        job = deepcopy(request['job'])
        ident = job['jobId']
        if not isinstance(ident, str) or not ident.startswith('run-') or any(char not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_' for char in ident):
            raise ValueError('Invalid evaluation job identity')
        path = directory / (ident + '.json')
        with FileLock(str(path) + '.lock', timeout=15):
            try:
                existing = read_json(path)
            except FileNotFoundError:
                existing = None
            if existing and job.get('status') == 'cancelled' and existing.get('finalization') is not None and job.get('finalization') is None:
                job['finalization'] = deepcopy(existing['finalization'])
            # Late progress or completion cannot undo an acknowledged cancel.
            # Finalization evidence is still accepted so cleanup remains visible.
            if existing and existing.get('status') == 'cancelled':
                finalization = job.get('finalization')
                job = {**job, **existing}
                if finalization is not None:
                    job['finalization'] = finalization
                    if job.get('cancellation'):
                        job['cancellation']['workerSettledAt'] = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
            job['updatedAt'] = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
            write_json(path, job)
            return job
    jobs = []
    for file in directory.iterdir():
        if not file.name.endswith('.json'):
            continue
        job = read_json(file)
        from storage.coordination import execute as coordinate
        if coordinate({'root': str(directory.parent), 'action': 'busy', 'key': 'comparison-execution:' + str(job.get('jobId', file.stem))}):
            jobs.append(job)
            continue
        changed = False
        if job.get('status') in ('queued', 'preparing', 'running', 'judging'):
            now = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
            job.update(status='interrupted', stageLabel='服务重启，运行已中断',
                       error={'code': 'SERVICE_RESTARTED', 'message': '评测服务重启，本次运行未继续执行，可发起单次重试。', 'retryable': True},
                       completedAt=now, updatedAt=now)
            changed = True
        operation = job.get('rescoringOperation')
        if isinstance(operation, dict) and operation.get('status') == 'RUNNING':
            operation.update(status='INTERRUPTED', finishedAt=datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
                             error='服务重启，重新评判已中断；可以再次发起。')
            changed = True
        if changed:
            write_json(file, job)
        jobs.append(job)
    return jobs


class JobStore:
    """Native callers read durable state, never a replica-local mutable cache."""
    def __init__(self, root):
        self.directory = filesystem_path(root) / 'runs'

    def initialize(self):
        return execute({'path': str(self.directory), 'action': 'initialize'})

    def get(self, identifier):
        import re
        if not isinstance(identifier, str) or not re.fullmatch(r'run-[A-Za-z0-9_-]+', identifier):
            return None
        try:
            return read_json(self.directory / (identifier + '.json'))
        except FileNotFoundError:
            return None

    def list(self, limit=50):
        values = [read_json(file) for file in self.directory.glob('*.json') if not file.is_symlink()]
        return sorted(values, key=lambda value: value['createdAt'], reverse=True)[:max(1, min(limit, 200))]

    def save(self, value):
        return execute({'path': str(self.directory), 'action': 'save', 'job': value})
