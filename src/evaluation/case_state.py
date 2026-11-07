"""One business invocation with independent capture/restore finalizers."""
import asyncio
from copy import deepcopy
from uuid import uuid4
from tasks.values import fingerprint


class ExecutionFailure(RuntimeError):
    def __init__(self, message, metadata=None):
        super().__init__(message)
        self.metadata = metadata or {}


async def with_case_state(request, port, execute, on_finished=None):
    fixture = request['evalCase']['stateFixture']
    record = {'version': '1', 'operationId': str(uuid4()), 'fixture': deepcopy(fixture),
              'status': 'INCOMPLETE', 'receipts': [], 'errors': []}

    async def action(phase, timeout):
        body = {'schemaVersion': 'finance.case-state.v1', 'operationId': record['operationId'], 'runId': request['runId'],
                'caseId': request['evalCase']['caseId'], 'side': request['side'], 'fixture': fixture, 'phase': phase}
        try:
            async with asyncio.timeout(timeout):
                receipt = await port(body)
            if not isinstance(receipt, dict) or set(receipt) - set(body) - {'status', 'stateDigest', 'state', 'message'}:
                raise ValueError('Invalid state receipt')
            if any(receipt.get(key) != value for key, value in body.items()):
                raise ValueError('State receipt correlation mismatch')
            if 'state' in receipt and (not isinstance(receipt['state'], dict) or fingerprint(receipt['state']) != receipt.get('stateDigest')):
                raise ValueError('State content digest mismatch')
            record['receipts'].append(deepcopy(receipt))
            if receipt.get('status') != 'SUCCEEDED' or not receipt.get('stateDigest'):
                raise ValueError('State operation did not succeed or omitted digest')
            if phase == 'capture' and 'state' not in receipt:
                raise ValueError('Final business state was not captured')
            if phase != 'capture' and receipt['stateDigest'] != fixture['initialStateDigest']:
                raise ValueError('Initial/restored business state does not match fixture')
        except (Exception, asyncio.CancelledError) as error:
            record['errors'].append({'phase': phase, 'message': str(error) or 'State operation cancelled'})
            raise

    result, failure = None, None
    try:
        await action('prepare', 30)
        result = await execute()
    except (Exception, asyncio.CancelledError) as error:
        failure = error
    finally:
        # Separate tasks shield restoration from a second cancellation of the
        # parent; each action has its own deadline and is awaited before exit.
        async def finalize():
            for phase in ('capture', 'restore'):
                try:
                    await action(phase, 10)
                except Exception:
                    pass
            record['status'] = 'INCOMPLETE' if record['errors'] else 'COMPLETE'
            if on_finished:
                on_finished(deepcopy(record))
        finishing = asyncio.create_task(finalize())
        try:
            await asyncio.shield(finishing)
        except asyncio.CancelledError as error:
            failure = failure or error
            await finishing
    if isinstance(failure, asyncio.CancelledError):
        raise failure
    if failure is not None or result is None:
        raise ExecutionFailure(str(failure) or 'Business execution unavailable', {
            **(getattr(failure, 'metadata', {}) or {}), 'caseState': record}) from failure
    captured = next((r for r in record['receipts'] if r['phase'] == 'capture' and r['status'] == 'SUCCEEDED'), {})
    return {**result, 'metadata': {**result.get('metadata', {}), 'caseState': record,
                                 **({'state': captured['state']} if 'state' in captured else {})}}
