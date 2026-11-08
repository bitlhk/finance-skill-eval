"""Run verifier scripts through the existing isolated project executor."""
import asyncio
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4


async def verify_script(script, evidence, timeout_ms=60000):
    from runtime.project import execute_project_command, verifier_result
    with TemporaryDirectory(prefix='finance-verifier-') as directory:
        root = Path(directory)
        (root / 'verify.py').write_text(script, encoding='utf-8')
        (root / 'evidence.json').write_text(json.dumps(evidence, ensure_ascii=False), encoding='utf-8')
        async with asyncio.timeout(timeout_ms / 1000 + 15):
            receipt = await execute_project_command(root, ['python', 'verify.py'], timeout_seconds=(timeout_ms + 999) // 1000,
                container_name='finance-project-' + str(uuid4()))
        result = verifier_result(receipt)
        if result['status'] != 'COMPLETED':
            raise ValueError('Verifier execution ' + result['status'] + ': ' + str(result.get('output', ''))[:1000])
        return result['result']
