"""Instance receipts never claim release while a native session is active."""
import asyncio
import unittest
from uuid import uuid4
from fastapi import HTTPException
from integrations.openjiuwen import worker
from integrations.openjiuwen.test_instance_manager import request


class WorkerCleanupTests(unittest.TestCase):
    def test_retired_instance_receipts_follow_actual_activity(self):
        item = worker.instances.create(request(), uuid4().hex)
        key = item['instanceId']
        marker = object()
        worker.instance_activity[key] = {marker}
        try:
            receipt = asyncio.run(worker.delete_runtime_instance(key))['cleanup']
            self.assertEqual(receipt['status'], 'PENDING')
            self.assertIsNone(worker.instances.get(key))
            self.assertEqual(asyncio.run(worker.delete_runtime_instance(key))['cleanup']['status'], 'PENDING')
            worker.instance_activity.pop(key)
            receipt = asyncio.run(worker.delete_runtime_instance(key))['cleanup']
            self.assertEqual(receipt['status'], 'RELEASED')
            self.assertEqual(receipt['instanceId'], key)
            self.assertEqual(receipt['scope'], 'THIS_INSTANCE')
            self.assertEqual(receipt['schemaVersion'], 'finance.eval-cleanup-observation.v1')
        finally:
            worker.instance_activity.pop(key, None)
            worker.retired_instances.pop(key, None)

    def test_unknown_instance_cannot_claim_release(self):
        with self.assertRaises(HTTPException) as error:
            asyncio.run(worker.delete_runtime_instance('never-created'))
        self.assertEqual(error.exception.status_code, 404)

    def test_failed_reaping_never_claims_release(self):
        item = worker.instances.create(request(), uuid4().hex)
        key = item['instanceId']
        worker.instance_cleanup_failures.add(key)
        try:
            self.assertEqual(asyncio.run(worker.delete_runtime_instance(key))['cleanup']['status'], 'FAILED')
        finally:
            worker.instance_cleanup_failures.discard(key)
            worker.retired_instances.pop(key, None)
