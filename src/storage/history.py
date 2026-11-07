"""Read-only history over the original files; never upgrades or rewrites evidence."""
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import re
import zipfile

from api.contracts import validator


DIRECTORIES = {'bundles': 'migration-bundles/tasks', 'migrations': 'migrations',
               'tasks': 'migration-tasks/tasks', 'environments': 'environments'}
ID = re.compile(r'[a-z0-9][a-z0-9-]{0,119}\Z')
REVISION = re.compile(r'(source|candidate-[a-z0-9-]+)\Z')
REASON = '此任务采用旧版任务或执行协议，当前版本无法安全恢复执行；历史分析、候选和验收结果仅供查阅，不代表已通过当前版本验收。'
NEXT = '可查看或下载历史留档，取出原始 Skill 后新建迁移任务，并在当前环境重新验收。'


class HistoryError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class HistoryStore:
    def __init__(self, root):
        self.root = Path(root).absolute()

    def check(self, origin, identifier):
        if origin not in DIRECTORIES or not ID.fullmatch(identifier):
            raise HistoryError('历史记录标识无效')

    def record_path(self, origin, identifier):
        return self.root / DIRECTORIES[origin] / (identifier + '.json')

    def safe(self, path):
        base = self.root.resolve(strict=True)
        expected = base / path.relative_to(self.root)
        actual = path.resolve(strict=True)
        if os.path.normcase(str(actual)) != os.path.normcase(str(expected)):
            raise HistoryError('历史文件路径已重定向，无法安全读取', 409)
        return actual

    def bytes(self, path):
        file = self.safe(path)
        if not file.is_file() or file.stat().st_size > 64 * 1024 * 1024:
            raise HistoryError('历史文件过大或不是普通文件，无法在线读取', 409)
        data = file.read_bytes()
        if len(data) > 64 * 1024 * 1024:
            raise HistoryError('历史文件过大或不是普通文件，无法在线读取', 409)
        return data

    def read(self, origin, identifier):
        data = self.bytes(self.record_path(origin, identifier))
        try:
            value = json.loads(data.decode('utf-8', errors='replace'))
        except ValueError:
            return None, '记录 JSON 已损坏，可下载原始留档排查。'
        if not isinstance(value, dict):
            return None, '记录不是有效对象，可下载原始留档排查。'
        stored = value.get('id', value.get('environmentId'))
        return value, '记录内标识与文件名不一致，按原文件留档，不能继续执行。' if stored and stored != identifier else None

    def historical(self, origin, record):
        if origin == 'tasks':
            return not record or record.get('schemaVersion') != 'finance.skill-migration.task.v3'
        if origin == 'environments':
            return not validator('environment_record').is_valid(record)
        return True

    def summary(self, origin, identifier, record, issue=None):
        record = record or {}
        delivery = record.get('delivery') or {}
        proof = delivery.get('evalConformance') or {} if isinstance(delivery, dict) else {}
        protocol = proof.get('instanceSchemaVersion') if isinstance(proof, dict) else None
        environment = origin == 'environments'
        reason = REASON
        if issue:
            reason = '记录不完整或格式不兼容，无法执行或修改；原始文件仍保留。'
        elif environment:
            reason = (f'该环境的验收记录使用旧协议 {protocol}，不能证明其符合当前 Runtime 协议。' if protocol else
                      '该环境登记格式已停用或不符合当前协议，不能作为可执行环境使用。')
        text = lambda value: value if isinstance(value, str) else None
        return {'origin': origin, 'id': identifier, 'name': text(record.get('name')) or identifier,
                'createdAt': text(record.get('createdAt')),
                'schemaVersion': text(record.get('schemaVersion')) or text(protocol) or text(record.get('type')) or '未知格式',
                'readOnly': True, 'reason': reason,
                'nextStep': '保留此登记作历史参考；升级 Runtime 后重新登记并完成当前版本预检或交付验收。' if environment else NEXT,
                **({'issue': issue} if issue else {})}

    def list(self, kind):
        if kind not in ('tasks', 'environments'):
            raise HistoryError('历史记录类型无效')
        result = []
        for origin in ('environments',) if kind == 'environments' else ('bundles', 'migrations', 'tasks'):
            try:
                directory = self.safe(self.root / DIRECTORIES[origin])
            except FileNotFoundError:
                continue
            for file in directory.glob('*.json'):
                identifier = file.stem
                if not ID.fullmatch(identifier):
                    continue
                try:
                    record, issue = self.read(origin, identifier)
                    if self.historical(origin, record):
                        result.append(self.summary(origin, identifier, record, issue))
                except (OSError, HistoryError):
                    result.append(self.summary(origin, identifier, None, '历史文件无法读取，请检查文件权限、大小和路径。'))
        result.sort(key=lambda item: item['id'])
        result.sort(key=lambda item: item['createdAt'] or '', reverse=True)
        return result

    def snapshot_directory(self, origin, identifier):
        return self.root / ('migration-bundles' if origin == 'bundles' else 'migration-tasks') / 'snapshots' / identifier

    def get(self, origin, identifier):
        self.check(origin, identifier)
        try:
            record, issue = self.read(origin, identifier)
        except FileNotFoundError:
            raise HistoryError('历史记录不存在', 404) from None
        if not self.historical(origin, record):
            raise HistoryError('此记录属于当前版本，请使用当前任务或环境入口', 409)
        result = {**self.summary(origin, identifier, record, issue), 'record': record, 'snapshots': []}
        if origin not in ('bundles', 'tasks'):
            return result
        try:
            files = self.safe(self.snapshot_directory(origin, identifier)).glob('*.json')
            revisions = sorted(file.stem for file in files if REVISION.fullmatch(file.stem))
            revisions.sort(key=lambda name: name != 'source')
            result['snapshots'] = [{'revision': name, 'label': '原始 Skill' if name == 'source' else name} for name in revisions]
            if not revisions:
                result['snapshotIssue'] = '未找到文件快照，仍可查看任务记录。'
            else:
                candidates = (record or {}).get('candidates', [])
                expected = ['source'] + [item['id'] for item in candidates if isinstance(item, dict)
                    and isinstance(item.get('id'), str) and REVISION.fullmatch(item['id'])] if isinstance(candidates, list) else ['source']
                missing = [name for name in expected if name not in revisions]
                if missing:
                    result['snapshotIssue'] = '以下文件快照缺失，不能还原该版本文件：' + '、'.join(missing)
        except (OSError, HistoryError):
            result['snapshotIssue'] = '文件快照缺失或不可读取，仍可查看任务记录。'
        return result

    def snapshot_data(self, origin, identifier, revision):
        detail = self.get(origin, identifier)
        if not REVISION.fullmatch(revision) or not any(item['revision'] == revision for item in detail['snapshots']):
            raise HistoryError('历史快照不存在', 404)
        try:
            value = json.loads(self.bytes(self.snapshot_directory(origin, identifier) / (revision + '.json')).decode('utf-8'))
            if not isinstance(value, dict) or not isinstance(value.get('files'), dict):
                raise HistoryError('历史快照缺少文件内容', 409)
            return value
        except (OSError, ValueError) as error:
            if isinstance(error, HistoryError):
                raise
            raise HistoryError('历史快照损坏或无法读取，可下载留档排查', 409) from None

    def snapshot(self, origin, identifier, revision):
        value = self.snapshot_data(origin, identifier, revision)
        return {'revision': revision, 'digest': value.get('digest'), 'files': sorted(value['files'])}

    def file(self, origin, identifier, revision, name):
        files = self.snapshot_data(origin, identifier, revision)['files']
        if name not in files or not isinstance(files[name], str):
            raise HistoryError('历史文件不存在', 404)
        try:
            content = base64.b64decode(files[name], validate=True)
        except ValueError:
            raise HistoryError('历史文件编码无效', 409) from None
        if base64.b64encode(content).decode() != files[name]:
            raise HistoryError('历史文件编码无效', 409)
        if len(content) > 1024 * 1024:
            text = '文件超过在线预览上限，请下载历史留档查看。'
        else:
            try:
                text = content.decode('utf-8-sig')
            except UnicodeError:
                text = '此文件为二进制，请下载历史留档查看。'
        return {'path': name, 'content': text}

    def archive(self, origin, identifier):
        detail = self.get(origin, identifier)
        files = {'record.json': self.bytes(self.record_path(origin, identifier))}
        issues, total = [], len(files['record.json'])
        for item in detail['snapshots']:
            revision = item['revision']
            try:
                data = self.bytes(self.snapshot_directory(origin, identifier) / (revision + '.json'))
            except (OSError, HistoryError):
                issues.append(revision + ' 无法读取，未包含在留档中')
                continue
            total += len(data)
            if total > 128 * 1024 * 1024:
                raise HistoryError('历史留档超过在线下载上限，请联系维护者从数据备份获取', 409)
            files['snapshots/' + revision + '.json'] = data
        files['history-manifest.json'] = json.dumps({'readOnly': True, 'reason': detail['reason'], 'nextStep': detail['nextStep'],
            **{key: detail[key] for key in ('issue', 'snapshotIssue') if key in detail}, 'issues': issues,
            'files': {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}, ensure_ascii=False, indent=2).encode()
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
            for name, data in files.items():
                archive.writestr(name, data)
        return output.getvalue()

    def blocked_task(self, identifier):
        if not ID.fullmatch(identifier):
            return None
        for origin in ('tasks', 'bundles'):
            try:
                record, issue = self.read(origin, identifier)
                return self.summary(origin, identifier, record, issue) if self.historical(origin, record) else None
            except FileNotFoundError:
                continue
        return None

    def blocked_environment(self, identifier):
        if not ID.fullmatch(identifier):
            return None
        try:
            record, issue = self.read('environments', identifier)
            return self.summary('environments', identifier, record, issue) if self.historical('environments', record) else None
        except FileNotFoundError:
            return None
