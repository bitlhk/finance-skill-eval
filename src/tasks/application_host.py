"""Cooperative host for Python application programs using existing I/O adapters.

Programs yield capability calls and receive their results. No I/O is performed
while handling a bridge message, so another task can progress or be paused.
Only transient call stacks live here; durable recovery uses task records and
the existing Jiuwen execution journal/checkpoints.
"""
from uuid import uuid4
import asyncio
import inspect


class CapabilityError(Exception):
    def __init__(self, detail):
        super().__init__(detail.get('message') or 'Capability failed')
        self.detail = detail
        self.status = detail.get('status', 500)


def call(capability, inputs=None, *, cleanup=False):
    return {'capability': capability, 'inputs': inputs or {}, 'cleanup': cleanup}


class ExecutionHost:
    def __init__(self):
        self.pending = {}

    def start(self, program):
        ident = str(uuid4())
        self.pending[ident] = {'program': program}
        return self._step(ident)

    def advance(self, ident, token, value=None, error=None):
        entry = self.pending.get(ident)
        if not entry or entry.get('token') != token:
            raise ValueError('Execution continuation does not match the pending capability')
        return self._step(ident, value, error)

    def discard(self, ident, token):
        entry = self.pending.get(ident)
        if entry and entry.get('token') == token:
            self.pending.pop(ident)['program'].close()

    def _step(self, ident, value=None, error=None):
        entry = self.pending[ident]
        try:
            effect = entry['program'].throw(CapabilityError(error)) if error else entry['program'].send(value)
            if not isinstance(effect, dict) or not isinstance(effect.get('capability'), str):
                raise ValueError('Application program yielded an invalid capability')
        except StopIteration as result:
            self.pending.pop(ident, None)
            return {'status': 'done', 'value': result.value}
        except BaseException:
            self.pending.pop(ident, None)
            raise
        entry['token'] = str(uuid4())
        return {'status': 'call', 'executionId': ident, 'token': entry['token'], **effect}


host = ExecutionHost()


def dispatch(request, programs):
    if request['action'] == 'start':
        return host.start(programs[request['input'].get('operation', 'run')](request['input']))
    if request['action'] == 'advance':
        return host.advance(request['executionId'], request['token'], request.get('value'), request.get('error'))
    if request['action'] == 'discard':
        return host.discard(request['executionId'], request['token'])
    raise ValueError('Unknown application execution command')


async def run_program(program, handlers, *, cancellation_context=None):
    """Run an existing application program with in-process Python adapters.

    The generator and its durable state policy are unchanged. Unlike dispatch,
    this path needs no bridge, continuation tokens, or TS capability callbacks.
    Cancellation stops new business calls while permitting declared finalizers
    to save receipts and release resources before propagating cancellation.
    """
    value = error = cancelled = None
    def cancellation_error():
        return CapabilityError({'message': 'Execution cancelled', 'aborted': True,
            **(cancellation_context() if cancellation_context is not None else {})})
    try:
        while True:
            try:
                effect = program.throw(error) if error is not None else program.send(value)
            except StopIteration as completed:
                if cancelled is not None:
                    raise cancelled
                return completed.value
            except CapabilityError:
                if cancelled is not None:
                    raise cancelled
                raise
            value = error = None
            if not isinstance(effect, dict) or not isinstance(effect.get('capability'), str):
                raise ValueError('Application program yielded an invalid capability')
            if cancelled is not None and not effect.get('cleanup'):
                error = cancellation_error()
                continue
            try:
                handler = handlers.get(effect['capability'])
                if handler is None:
                    raise ValueError('Unsupported capability: ' + effect['capability'])
                value = handler(effect.get('inputs', {}))
                if inspect.isawaitable(value):
                    value = await value
            except asyncio.CancelledError as failure:
                cancelled = failure
                error = cancellation_error()
            except CapabilityError as failure:
                error = failure
            except Exception as failure:
                error = CapabilityError({'name': type(failure).__name__, 'message': str(failure),
                                         'status': getattr(failure, 'status', 500)})
    finally:
        program.close()
