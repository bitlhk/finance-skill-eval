"""Bounded execution-side records; no collector, network exporter or new endpoint."""
import asyncio
import json
import re
import time


class EvaluationProcess:
    def __init__(self, redact=lambda value: value):
        self.records, self.active, self.gaps = [], {}, set()
        self.redact = redact

    def safe(self, value, depth=0):
        if depth > 8:
            self.gaps.add('DEPTH_LIMIT')
            return '[omitted]'
        if hasattr(value, 'model_dump'):
            value = value.model_dump()
        if isinstance(value, dict):
            result = {}
            for key, item in value.items():
                if re.search(r'authorization|api.?key|password|secret|cookie|token|reasoning|chain.?of.?thought', str(key), re.I):
                    self.gaps.add('FIELDS_REDACTED')
                    continue
                result[str(key)] = self.safe(item, depth + 1)
            return result
        if isinstance(value, (list, tuple)):
            return [self.safe(item, depth + 1) for item in value]
        if isinstance(value, str):
            try:
                decoded = json.loads(value)
                if isinstance(decoded, (dict, list)):
                    return self.safe(decoded, depth + 1)
            except ValueError:
                pass
            return self.redact(value)
        if value is None or isinstance(value, (int, float, bool)):
            return value
        self.gaps.add('UNSUPPORTED_VALUE')
        return '[omitted]'

    def start(self, kind, name, inputs=None):
        if len(self.records) >= 128:
            self.gaps.add('RECORD_LIMIT')
            return
        index = len(self.records)
        record = {'id': f'record-{index}', 'kind': kind, 'callId': f'call-{index}',
                  'name': str(name or 'model')[:200], 'status': 'incomplete'}
        if inputs is not None:
            record['input'] = self.safe(inputs)
        self.records.append(record)
        self.active.setdefault((id(asyncio.current_task()), kind, name), []).append((record, time.monotonic()))

    def end(self, kind, name, output=None, failed=False):
        entries = self.active.get((id(asyncio.current_task()), kind, name), [])
        if not entries:
            self.gaps.add('UNMATCHED_CALL')
            return
        record, started = entries.pop()
        record.update(status='failed' if failed else 'completed', durationMs=round((time.monotonic()-started)*1000))
        if output is not None:
            record['output'] = self.safe(output)

    def finish(self):
        if not self.records:
            return {'schemaVersion': 'finance.runtime-process.v1', 'status': 'UNAVAILABLE',
                    'scopes': [], 'records': [], 'reason': 'NO_OBSERVED_CALLS'}
        if any(self.active.values()):
            self.gaps.add('UNFINISHED_CALLS')
        records, size = [], 0
        for record in self.records:
            try:
                encoded = json.dumps(record, ensure_ascii=False, allow_nan=False).encode('utf-8')
                if len(encoded) > 16384 or size + len(encoded) > 65536:
                    self.gaps.add('CONTENT_LIMIT')
                    record = {key: value for key, value in record.items() if key not in ('input', 'output')}
                    encoded = json.dumps(record).encode('utf-8')
                size += len(encoded)
                records.append(record)
            except (ValueError, TypeError):
                self.gaps.add('INVALID_JSON')
        return {'schemaVersion': 'finance.runtime-process.v1', 'status': 'PARTIAL' if self.gaps else 'COMPLETE',
                'scopes': ['models', 'tools'], 'records': records,
                **({'reason': ','.join(sorted(self.gaps))} if self.gaps else {})}

    def rail(self):
        from openjiuwen.harness.rails.base import AgentRail
        process = self
        class ProcessRail(AgentRail):
            async def before_model_call(self, ctx):
                process.gaps.add('MODEL_INPUT_NOT_CAPTURED')
                process.start('model', 'model')
            async def after_model_call(self, ctx):
                response = getattr(getattr(ctx, 'inputs', None), 'response', None)
                if response is None:
                    process.gaps.add('MODEL_RESPONSE_NOT_CAPTURED')
                process.end('model', 'model', getattr(response, 'content', None))
            async def on_model_exception(self, ctx): process.end('model', 'model', failed=True)
            async def before_tool_call(self, ctx):
                process.start('tool', getattr(ctx.inputs, 'tool_name', ''), getattr(ctx.inputs, 'tool_args', None))
            async def after_tool_call(self, ctx):
                result = getattr(ctx.inputs, 'tool_result', None)
                process.end('tool', getattr(ctx.inputs, 'tool_name', ''), result, getattr(result, 'success', None) is False)
            async def on_tool_exception(self, ctx): process.end('tool', getattr(ctx.inputs, 'tool_name', ''), failed=True)
        return ProcessRail()
