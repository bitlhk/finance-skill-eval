"""Existing replay CLI using the same native evaluation service as HTTP."""
import argparse
import asyncio
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from api.configuration import load_configuration
from evaluation.packs import load_pack
from evaluation.reporting import html_report
from evaluation.service import EvaluationRunService


async def replay(file, output):
    pack = load_pack(file)
    with TemporaryDirectory(prefix='finance-replay-') as directory:
        service = EvaluationRunService(load_configuration({'dataDirectory': directory, 'coordinationDirectory': directory}))
        class Catalog:
            def get(self, identifier):
                return pack if identifier == pack['packId'] else None
        service.catalog = Catalog()
        await service.initialize()
        try:
            job = await service.create({'packId': pack['packId'], 'runtime': {'type': 'replay'}, 'judgeMode': 'deterministic'})
            while job['status'] not in ('completed', 'failed', 'cancelled', 'interrupted'):
                await asyncio.sleep(.1)
                job = await service.get(job['jobId'])
            if job['status'] != 'completed':
                raise ValueError((job.get('error') or {}).get('message', 'Replay did not complete'))
            output = Path(output).resolve()
            output.mkdir(parents=True, exist_ok=True)
            (output / 'report.json').write_text(json.dumps(job['report'], ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            (output / 'report.html').write_text(html_report(job['report']), encoding='utf-8')
            print(job['report']['summary']['headline'])
            print(output)
        finally:
            await service.close()


def main():
    parser = argparse.ArgumentParser(prog='finance-skill-eval')
    commands = parser.add_subparsers(dest='command', required=True)
    command = commands.add_parser('replay')
    command.add_argument('--pack', required=True)
    command.add_argument('--out', required=True)
    options = parser.parse_args()
    asyncio.run(replay(options.pack, options.out))


if __name__ == '__main__':
    main()
