"""Private real-model test host. Actual Builder releases/results, no seeded verdicts."""
import argparse
import json
import os
from pathlib import Path
import sys
import time
from uuid import uuid4

parser = argparse.ArgumentParser()
parser.add_argument('--builder-root', type=Path, required=True)
parser.add_argument('--state-root', type=Path, required=True)
parser.add_argument('--python', type=Path, required=True)
args = parser.parse_args()
sys.path[:0] = [str(args.builder_root / 'src'), str(args.builder_root.parent / 'base/src')]
from finance_solution_builder.runtime_builder import RuntimeBuilder, PROTOCOLS, with_digest
from finance_solution_builder.runtime_construction import source_archive, source_snapshot
from finance_solution_builder.runtime_package_release import ManagedPackageRelease
from finance_solution_builder.eval_package_contract import RUNTIME_VERSION
from finance_solution_builder.eval_package_release_sources import package_worker_sources
from finance_solution_builder.method_assets import write_private

root = args.state_root.resolve()
root.mkdir(parents=True, exist_ok=False)
template = root / 'template'
template.mkdir()
for name, content in package_worker_sources().items():
    (template / name).write_bytes(content)
artifact = source_archive(source_snapshot(template))
preset = {'owner': 'cross-deployment-acceptance', 'runtime': {'type': 'openjiuwen', 'version': RUNTIME_VERSION},
    'model': {'modelId': 'builder-package-model', 'upstreamModelId': os.environ['CLOSEOUT_MODEL_NAME']},
    'toolNames': ['read_file', 'skill_tool'], 'trustedLocalExecution': True, 'resultEvidence': 'redacted_results',
    'modelConnection': {'baseUrl': os.environ['CLOSEOUT_MODEL_BASE'], 'upstreamModelId': os.environ['CLOSEOUT_MODEL_NAME'],
        'apiKey': os.environ['CLOSEOUT_RUNTIME_MODEL_KEY']}}
releases = []
try:
    records = []
    for index in range(2):
        release = ManagedPackageRelease(artifact=artifact, deployment_id='reuse-' + uuid4().hex,
            state_root=root / 'deployments', python=args.python, preset=preset)
        releases.append(release)
        requirements = with_digest({'schemaVersion': 'finance.runtime-build-requirements.v1',
            'requestId': 'cross-deployment-admission-' + str(index),
            'source': json.loads(os.environ['CLOSEOUT_SOURCE_IDENTITY']),
            'target': {'runtimeType': 'openjiuwen', 'protocols': PROTOCOLS}, 'requiredCapabilities': []}, 'requirementsDigest')
        result = RuntimeBuilder([], lambda _: release.deployment).build(requirements)
        if result['status'] != 'SUCCEEDED':
            raise RuntimeError('BUILDER_DELIVERY_FAILED')
        records.append({'requirements': requirements, 'result': result, 'connection': release.private_connection_info()})
    write_private(root / 'deliveries.json', {'status': 'READY', 'records': records})
    print('READY: two actual Builder-managed releases; private connections retained locally.', flush=True)
    while not (root / 'stop').exists():
        for release in releases:
            release.verify_loaded_artifact(release.deployment.artifact_sha256)
        time.sleep(1)
finally:
    for release in reversed(releases):
        release.close()
    print('STOPPED: test releases and instances closed.', flush=True)
