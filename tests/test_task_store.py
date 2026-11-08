import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import errno
import shutil
import base64
import os
import stat

from storage.tasks import TaskProtocolError, execute, filesystem_path, write_json
from storage.jobs import execute as recover_jobs
from assets.snapshot import files_digest


def snapshot(content=b'test'):
    files = {'SKILL.md': base64.b64encode(content).decode('ascii')}
    return {'digest': files_digest(files), 'members': [], 'files': files}


class TaskStoreTest(unittest.TestCase):
    def test_running_evaluation_jobs_recover_as_interrupted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'run.json').write_text(json.dumps({'jobId': 'run', 'status': 'running'}), encoding='utf-8')
            (root / 'done.json').write_text(json.dumps({'jobId': 'done', 'status': 'completed'}), encoding='utf-8')
            result = recover_jobs({'path': directory, 'action': 'initialize'})
            jobs = {item['jobId']: item for item in result}
            self.assertEqual(jobs['run']['status'], 'interrupted')
            self.assertEqual(jobs['run']['error']['code'], 'SERVICE_RESTARTED')
            self.assertEqual(jobs['done']['status'], 'completed')
            self.assertEqual(json.loads((root / 'run.json').read_text(encoding='utf-8'))['status'], 'interrupted')

    def test_interrupted_rescoring_keeps_completed_report(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = {'jobId': 'done', 'status': 'completed', 'report': {'cases': [1]},
                        'rescoringOperation': {'id': 'op', 'status': 'RUNNING', 'startedAt': '2026-01-01'}}
            (root / 'done.json').write_text(json.dumps(original), encoding='utf-8')
            result = recover_jobs({'path': directory, 'action': 'initialize'})[0]
            self.assertEqual(result['status'], 'completed')
            self.assertEqual(result['report'], original['report'])
            self.assertEqual(result['rescoringOperation']['status'], 'INTERRUPTED')

    def test_deep_workspace_paths_preserve_existing_data(self):
        with tempfile.TemporaryDirectory() as directory:
            root = filesystem_path(directory) / ('account-' + 'a' * 70) / ('workspace-' + 'b' * 70)
            try:
                request = {'root': str(root), 'id': 'bundle-abc'}
                item = {'schemaVersion': 'finance.skill-migration.task.v3', 'id': 'bundle-abc', 'createdAt': '2026'}
                execute({**request, 'action': 'saveSnapshot', 'revision': 'source', 'value': snapshot()})
                execute({**request, 'action': 'save', 'value': item})
                self.assertEqual(execute({**request, 'action': 'get'}), item)
                self.assertEqual(execute({**request, 'action': 'readSnapshot', 'revision': 'source'}), snapshot())
            finally:
                if root.exists() and root.resolve().is_relative_to(filesystem_path(directory).resolve()):
                    def remove_readonly(function, path, _error):
                        os.chmod(path, stat.S_IWRITE)
                        function(path)
                    shutil.rmtree(root, onerror=remove_readonly)

    def test_atomic_write_retries_sharing_error_and_cleans_up_fatal_error(self):
        import os
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'task.json'
            original = os.replace
            outcomes = [PermissionError(errno.EPERM, 'in use'), PermissionError(errno.EACCES, 'in use')]
            def replace(source, destination):
                if outcomes:
                    raise outcomes.pop(0)
                return original(source, destination)
            with patch('storage.tasks.os.replace', side_effect=replace):
                write_json(target, {'status': 'PASSED'})
            self.assertEqual(json.loads(target.read_text(encoding='utf-8')), {'status': 'PASSED'})
            target.unlink()
            with patch('storage.tasks.os.replace', side_effect=OSError(errno.EXDEV, 'cross-device')):
                with self.assertRaises(OSError):
                    write_json(target, {'status': 'PASSED'})
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_existing_task_and_snapshot_round_trip(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tasks = root / 'migration-tasks' / 'tasks'
            tasks.mkdir(parents=True)
            original = {'schemaVersion': 'finance.skill-migration.task.v3', 'id': 'bundle-a1',
                        'createdAt': '2026-01-01T00:00:00Z', 'description': '原有任务'}
            (tasks / 'bundle-a1.json').write_text(json.dumps(original), encoding='utf-8')
            request = {'root': directory, 'id': 'bundle-a1'}
            self.assertEqual(execute({**request, 'action': 'get'}), original)
            self.assertEqual(execute({'root': directory, 'action': 'list'}), [original])
            frozen = snapshot('示例'.encode())
            execute({**request, 'action': 'saveSnapshot', 'revision': 'source', 'value': frozen})
            self.assertEqual(execute({**request, 'action': 'readSnapshot', 'revision': 'source'}), frozen)
            self.assertFalse((root / 'migration-tasks' / 'snapshots').exists())
            execute({**request, 'action': 'save', 'value': {**original, 'description': '已更新'}})
            self.assertEqual(json.loads((tasks / 'bundle-a1.json').read_text(encoding='utf-8'))['description'], '已更新')

    def test_path_validation_and_protocol(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                execute({'root': directory, 'action': 'get', 'id': 'bundle-../outside'})
            with self.assertRaises(ValueError):
                execute({'root': directory, 'action': 'saveSnapshot', 'id': 'bundle-ab',
                         'revision': '../outside', 'value': {}})
            tasks = Path(directory) / 'migration-tasks' / 'tasks'
            tasks.mkdir(parents=True)
            (tasks / 'bundle-ab.json').write_text('{"schemaVersion":"other"}', encoding='utf-8')
            with self.assertRaises(TaskProtocolError):
                execute({'root': directory, 'action': 'get', 'id': 'bundle-ab'})

    def test_old_json_snapshot_cannot_be_used_by_current_tasks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tasks = root / 'migration-tasks' / 'tasks'
            snapshots = root / 'migration-tasks' / 'snapshots' / 'bundle-ab'
            tasks.mkdir(parents=True)
            snapshots.mkdir(parents=True)
            request = {'root': directory, 'id': 'bundle-ab'}
            task_file = tasks / 'bundle-ab.json'
            snapshot_file = snapshots / 'source.json'
            old_snapshot = json.dumps(snapshot())
            snapshot_file.write_text(old_snapshot, encoding='utf-8')
            task_file.write_text(json.dumps({'schemaVersion': 'finance.skill-migration.task.v1'}), encoding='utf-8')
            with self.assertRaises(TaskProtocolError):
                execute({**request, 'action': 'readSnapshot', 'revision': 'source'})
            task_file.write_text(json.dumps({'schemaVersion': 'finance.skill-migration.task.v3'}), encoding='utf-8')
            with self.assertRaises(RuntimeError):
                execute({**request, 'action': 'readSnapshot', 'revision': 'source'})
            self.assertEqual(snapshot_file.read_text(encoding='utf-8'), old_snapshot)


if __name__ == '__main__':
    unittest.main()
