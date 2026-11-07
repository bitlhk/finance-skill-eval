"""Fixed two-sided business execution using the shared native Launcher.

Grading material stays in the evaluation service. Each side executes cases in
order; the two sides may run concurrently. Both owners are finalized even if
preparation, execution or the client connection fails.
"""
import asyncio
from copy import deepcopy
import time

from runtime.launcher import RuntimeLauncher
from evaluation.execution import execute_case
from tasks.values import now


async def execute_launchers(body, emit, factory=RuntimeLauncher):
    run_id, pack = body['runId'], body['pack']
    if not body['launchers'] or set(body['launchers']) - {'left', 'right'}:
        raise ValueError('Invalid execution sides')
    owners = {side: factory(options) for side, options in body['launchers'].items()}
    evidence, completed = {}, 0
    cleanup_errors, cleanup_started = [], set()

    async def release(side):
        if side in cleanup_started:
            return
        cleanup_started.add(side)
        async def cleanup():
            try:
                await owners[side].cleanup()
            except Exception as error:
                cleanup_errors.append({'side': side, 'errorType': type(error).__name__})
                raise
        finishing = asyncio.create_task(cleanup())
        try:
            await asyncio.shield(finishing)
        except asyncio.CancelledError:
            await finishing
            raise

    async def run_cases(side):
        nonlocal completed
        owner = owners[side]
        await owner.prepare({'runId': run_id})
        for original in pack['cases']:
            case = deepcopy(original)
            case.pop('evaluationPlan', None)
            request = {'runId': run_id, 'side': side, 'evalCase': case,
                       'model': pack['models']['execution'][side], 'variant': pack['variants'][side]}
            result = await execute_case(owner, request, on_event=lambda event: emit({'progress': {
                    'stage': 'executing', 'completedRuns': completed, 'totalRuns': len(pack['cases']) * 2,
                    'caseId': case['caseId'], 'side': side, 'event': event}}))
            evidence.setdefault(case['caseId'], {})[side] = result
            completed += 1
            await emit({'progress': {'stage': 'executing', 'completedRuns': completed, 'totalRuns': len(pack['cases']) * 2,
                                    'caseId': case['caseId'], 'side': side, 'evidence': result}})

    async def execute_side(side):
        try:
            await run_cases(side)
        finally:
            # Release this side before waiting for its peer. A Launcher with
            # capacity one can then admit the other side without deadlocking.
            await release(side)

    tasks = []
    try:
        if any(case.get('stateFixture') for case in pack['cases']):
            # Lifecycle receipts prove reset/capture/restore, not independent
            # backing databases. Do not overlap two sides' mutable fixtures.
            for side in owners:
                await execute_side(side)
        else:
            tasks = [asyncio.create_task(execute_side(side)) for side in owners]
            await asyncio.gather(*tasks)
        return evidence
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        async def finalize():
            for side in reversed(list(owners)):
                try:
                    await release(side)
                except Exception:
                    pass
            await emit({'finalization': {'observedAt': now(), 'resources': {
                side: owner.finalization_evidence() for side, owner in owners.items()}, 'errors': cleanup_errors}})
        cleanup = asyncio.create_task(finalize())
        try:
            await asyncio.shield(cleanup)
        except asyncio.CancelledError:
            await cleanup
            raise
        if cleanup_errors:
            raise RuntimeError('Runtime side cleanup failed')
