import asyncio
import base64
import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace

from assets.snapshot import files_digest
from .delivery_review_snapshot import DeliveryReviewSnapshots


class DeliveryReviewSnapshotTests(unittest.IsolatedAsyncioTestCase):
    async def test_snapshot_is_frozen_and_evidence_is_bound_to_that_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace=Path(directory)
            (workspace/'candidate').mkdir()
            (workspace/'candidate'/'tool.py').write_text('original',encoding='utf-8')
            (workspace/'task').mkdir()
            (workspace/'task'/'manifest.json').write_text('{}',encoding='utf-8')
            encoded={'tool.py':base64.b64encode(b'original').decode()}
            digest=files_digest(encoded)
            spec=SimpleNamespace(agent_card=SimpleNamespace(name='migration_delivery_reviewer'),system_prompt='审查者')
            agent=SimpleNamespace(deep_config=SimpleNamespace(subagents=[spec]))
            checks=[{'receiptId':'project-check-1','snapshotDigest':digest,'status':'COMPLETED','exitCode':0},
                    {'receiptId':'project-check-2','snapshotDigest':'old','status':'FAILED','exitCode':1}]
            live=[]
            from unittest.mock import AsyncMock
            registration = {'registered': True, 'services': [], 'tools': [{'toolId': 'cli'}]}
            query = SimpleNamespace(invoke=AsyncMock(return_value=registration))
            snapshots=DeliveryReviewSnapshots(agent,workspace,{'SKILL.md':base64.b64encode(b'source').decode()},
                [{'runId':'dev','status':'PASSED','candidateDigest':digest}], checks, live, delivery_query=query)
            self.assertEqual(await snapshots.start('review-1'),digest)
            frozen=Path(spec.workspace.root_path)
            registration['registered'] = False
            self.assertTrue(json.loads((frozen/'task/delivery-tools.json').read_text(encoding='utf-8'))['registered'])
            (workspace/'candidate'/'tool.py').write_text('changed',encoding='utf-8')
            self.assertEqual((frozen/'candidate'/'tool.py').read_text(encoding='utf-8'),'original')
            self.assertEqual((frozen/'source'/'SKILL.md').read_text(encoding='utf-8'),'source')
            lookup=next(tool for tool in spec.tools if tool.card.name=='query_development_evaluations')
            self.assertTrue((await lookup.invoke({'run_id':'dev'}))['matchesCurrentWorkspace'])
            project_checks=next(tool for tool in spec.tools if tool.card.name=='query_project_checks')
            live.append({'receiptId':'project-check-3','snapshotDigest':digest,'status':'COMPLETED','exitCode':0})
            observed=(await project_checks.invoke({}))['checks']
            self.assertEqual([item['matchesReviewedWorkspace'] for item in observed],[True,False,True])
            submit=next(tool for tool in spec.tools if tool.card.name=='record_delivery_review')
            self.assertFalse((await submit.invoke({'decision':'RECOMMEND','summary':'ok'}))['accepted'])
            self.assertFalse((await submit.invoke({'decision':'RECOMMEND','summary':'ok',
                'citations':[{'path':'candidate/tool.py','quote':'invented'}]}))['accepted'])
            self.assertFalse((await submit.invoke({'decision':'RECOMMEND','summary':'ok',
                'citations':[{'path':'candidate/../source/SKILL.md','quote':'source'}]}))['accepted'])
            basic={'status':'SUFFICIENT','scope':'命令检查','reason':'命令成功','coversTaskScope':True,
                'references':[{'kind':'project_check','id':'project-check-2'}]}
            self.assertFalse((await submit.invoke({'decision':'RECOMMEND','summary':'ok',
                'citations':[{'path':'candidate/tool.py','quote':'original'}],'basic_review':basic}))['accepted'])
            basic['references'][0]['id']='project-check-1'
            self.assertTrue((await submit.invoke({'decision':'RECOMMEND','summary':'源码已核对',
                'citations':[{'path':'candidate/tool.py','quote':'original'}],'basic_review':basic}))['accepted'])
            self.assertFalse((await submit.invoke({'decision':'REVISE','summary':'不可覆盖'}))['accepted'])
            pending=asyncio.create_task(snapshots.start('review-2'))
            await asyncio.sleep(0.05)
            self.assertFalse(pending.done())
            result=await snapshots.finish('review-1')
            self.assertEqual(result['digest'],digest)
            self.assertEqual(result['review']['decision'],'RECOMMEND')
            self.assertEqual(result['review']['basicReview'],basic)
            self.assertFalse(frozen.exists())
            self.assertNotEqual(await asyncio.wait_for(pending,2),digest)
            await snapshots.finish('review-2')
            self.assertEqual((workspace/'candidate'/'tool.py').read_text(encoding='utf-8'),'changed')
