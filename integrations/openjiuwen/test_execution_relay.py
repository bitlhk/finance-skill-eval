import asyncio
import unittest
import tempfile
import subprocess
import sys
import hashlib
import os

from .execution_relay import ExecutionRelay


class ExecutionRelayTests(unittest.IsolatedAsyncioTestCase):
    async def test_terminal_receipt_is_complete_before_producer_cleanup(self):
        with tempfile.TemporaryDirectory() as root:
            relay=ExecutionRelay(journal_root=root)
            blocked=asyncio.Event()
            async def produce():
                yield {'result':'committed result'}
                await blocked.wait()
            relay.start('task','run',{},produce)
            events=[item async for item in relay.subscribe('task','run')]
            self.assertEqual(events[-1]['record'],{'result':'committed result'})
            self.assertEqual(relay.state('task','run'),'completed')
            await relay.close()
            restored=ExecutionRelay(journal_root=root)
            self.assertEqual(restored.state('task','run'),'completed')
            self.assertEqual([item async for item in restored.subscribe('task','run')],events)
            await restored.close()

    async def test_completed_receipt_survives_runtime_replacement_without_reexecution(self):
        with tempfile.TemporaryDirectory() as root:
            first = ExecutionRelay(journal_root=root)
            calls = 0
            async def produce():
                nonlocal calls
                calls += 1
                yield {'result': {'status': 'PRODUCED'}}
            first.start('task', 'run', {}, produce)
            original = [item async for item in first.subscribe('task', 'run')]
            await first.close()
            replacement = ExecutionRelay(journal_root=root)
            replacement.start('task', 'run', {}, produce)
            self.assertEqual([item async for item in replacement.subscribe('task', 'run')], original)
            self.assertEqual(calls, 1)
            self.assertEqual(replacement.state('task', 'run'), 'completed')
            await replacement.close()

    async def test_other_runtime_can_read_live_receipts_without_starting_a_second_producer(self):
        with tempfile.TemporaryDirectory() as root:
            first, second = ExecutionRelay(journal_root=root), ExecutionRelay(journal_root=root)
            released = asyncio.Event()
            calls = 0
            async def produce():
                nonlocal calls
                calls += 1
                yield {'activity': 'started'}
                await released.wait()
                yield {'result': 'done'}
            first.start('task', 'run', {}, produce)
            stream = first.subscribe('task', 'run')
            await anext(stream)
            second.start('task', 'run', {}, produce)
            released.set()
            events = [item async for item in second.subscribe('task', 'run')]
            self.assertEqual(len(events), 2)
            self.assertEqual(calls, 1)
            await stream.aclose()
            await first.close()
            await second.close()

    async def test_killed_runtime_is_detected_and_partial_receipts_are_not_replayed_as_work(self):
        with tempfile.TemporaryDirectory() as root:
            script = ('import sys,time; from integrations.openjiuwen.execution_journal import ExecutionJournal; '
                      'j=ExecutionJournal(sys.argv[1],100000); '
                      'lock=j.start("task","run",sys.argv[2]); '
                      'j.append("task","run",{"activity":"started"}); print("ready",flush=True); time.sleep(60)')
            digest = hashlib.sha256(b'{}').hexdigest()
            child = subprocess.Popen([sys.executable, '-B', '-c', script, root, digest],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                self.assertEqual(child.stdout.readline().strip(), 'ready')
                replacement = ExecutionRelay(journal_root=root)
                self.assertEqual(replacement.state('task', 'run'), 'running')
                if os.name == 'nt':
                    subprocess.run(['taskkill', '/PID', str(child.pid), '/T', '/F'], check=True, capture_output=True)
                else:
                    child.kill()
                child.wait(timeout=10)
                self.assertEqual(replacement.state('task', 'run'), 'interrupted')
                calls = 0
                async def forbidden():
                    nonlocal calls
                    calls += 1
                    yield {'result': 'must not run'}
                replacement.start('task', 'run', {}, forbidden)
                with self.assertRaisesRegex(RuntimeError, 'without a confirmed result'):
                    _ = [item async for item in replacement.subscribe('task', 'run')]
                self.assertEqual(calls, 0)
                self.assertEqual(replacement.journal.records('task', 'run', 0)[0]['record'], {'activity': 'started'})
                await replacement.close()
            finally:
                if child.poll() is None:
                    if os.name == 'nt':
                        subprocess.run(['taskkill', '/PID', str(child.pid), '/T', '/F'], capture_output=True)
                    else:
                        child.kill()
                child.communicate(timeout=10)

    async def test_disconnected_subscriber_can_reattach_without_reexecuting(self):
        relay = ExecutionRelay()
        release = asyncio.Event()
        started = 0

        async def producer():
            nonlocal started
            started += 1
            yield {'activity': 'started'}
            await release.wait()
            yield {'result': 'finished'}

        payload = {'task': 'one'}
        relay.start('session', 'run', payload, producer)
        first = relay.subscribe('session', 'run')
        self.assertEqual(await anext(first), {'sequence': 1, 'record': {'activity': 'started'}})
        await first.aclose()
        relay.start('session', 'run', payload, producer)
        with self.assertRaises(ValueError):
            relay.start('session', 'run', {'task': 'different'}, producer)
        release.set()
        self.assertEqual([item async for item in relay.subscribe('session', 'run', after=1)],
                         [{'sequence': 2, 'record': {'result': 'finished'}}])
        self.assertEqual(started, 1)
        with self.assertRaises(KeyError):
            _ = [item async for item in relay.subscribe('other', 'run')]
        await relay.close()

    async def test_failed_producer_does_not_appear_as_success(self):
        relay = ExecutionRelay()

        async def producer():
            yield {'activity': 'started'}
            raise RuntimeError('private failure details')

        relay.start('session', 'run', {}, producer)
        with self.assertRaisesRegex(RuntimeError, 'without a confirmed result'):
            _ = [item async for item in relay.subscribe('session', 'run')]
        await relay.close()

    async def test_capacity_limit_does_not_report_unbuffered_result_as_complete(self):
        relay = ExecutionRelay(max_bytes=32)

        async def producer():
            yield {'activity': 'started'}
            yield {'result': 'x' * 100}

        relay.start('session', 'run', {}, producer)
        received = []
        with self.assertRaisesRegex(RuntimeError, 'without a confirmed result'):
            async for item in relay.subscribe('session', 'run'):
                received.append(item)
        self.assertEqual(received, [{'sequence': 1, 'record': {'activity': 'started'}}])
        await relay.close()
