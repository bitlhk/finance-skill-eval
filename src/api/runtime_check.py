"""Operator Launcher intake CLI; shares platform validation, not business grading."""
import argparse
import asyncio
import json
import os
from pathlib import Path
from api.contracts import parse
from runtime.build_admission import feature_issues
from runtime.contracts import validate
from runtime.launcher import base_url
from runtime.transport import client, bounded_json, require_success
from evaluation.checks import execution_checks
from evaluation.execution import validate_telemetry
from evaluation.process import with_process


def inspect(capabilities, features=(), evidence=None, identity=None):
    issues = []
    try:
        validate('finance.runtime-capabilities.v1', capabilities)
        issues.extend(feature_issues(capabilities, ['processEvidence', *features]))
    except ValueError:
        issues.append('INVALID_CAPABILITIES')
    compatible = not issues
    execution, collection = 'NOT_PROVIDED', None
    if evidence is not None:
        checks = []
        try:
            observed = parse('execution_evidence', evidence)
            process = (observed.get('metadata') or {}).get('process')
            if process:
                validate('finance.runtime-process.v1', process)
                collection = {key: process[key] for key in ('status', 'scopes')}
            checks.extend(check['id'] for check in execution_checks(observed) if check['status'] != 'PASS')
            with_process(observed, True)
            if not identity:
                checks.append('execution.expected-identity-missing')
            elif any(observed.get(key) != identity[key] for key in ('runId', 'caseId', 'side')):
                checks.append('execution.correlation')
            metadata = observed.get('metadata') or {}
            if 'projectExecution' in features and (metadata.get('projectExecution') is not True or not isinstance(metadata.get('contentDigest'), str)):
                checks.append('execution.project')
            if 'otlpEvidence' in features or 'otlpExport' in features:
                correlated = {'finance.run.id': identity['runId'], 'finance.case.id': identity['caseId'], 'finance.side': identity['side']} if identity else {}
                if validate_telemetry(metadata.get('telemetry'), correlated)['status'] != 'COMPLETE':
                    checks.append('execution.telemetry-incomplete')
        except (ValueError, KeyError, TypeError):
            checks.append('INVALID_EXECUTION_EVIDENCE')
        issues.extend(checks)
        execution = 'INCOMPLETE' if checks else 'VERIFIED'
    return {'compatible': compatible, 'execution': execution, **({'processCollection': collection} if collection else {}),
        'issues': issues, 'businessAcceptance': 'NOT_EVALUATED'}


async def main():
    parser = argparse.ArgumentParser()
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--capabilities')
    source.add_argument('--url')
    for argument in ('require', 'evidence', 'run-id', 'case-id', 'side'):
        parser.add_argument('--' + argument)
    options = parser.parse_args()
    if options.url:
        async with client(10) as http:
            token = os.getenv('RUNTIME_CHECK_TOKEN')
            async with http.stream('GET', base_url(options.url) + 'v1/runtime-capabilities',
                    headers={'authorization': 'Bearer ' + token} if token else {}) as response:
                await require_success(response)
                capabilities = await bounded_json(response)
    else:
        capabilities = json.loads(Path(options.capabilities).read_text(encoding='utf-8'))
    identity = {'runId': options.run_id, 'caseId': options.case_id, 'side': options.side} if all((options.run_id, options.case_id, options.side)) else None
    result = inspect(capabilities, (getattr(options, 'require') or '').split(',') if getattr(options, 'require') else [],
        json.loads(Path(options.evidence).read_text(encoding='utf-8')) if options.evidence else None, identity)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if not result['compatible'] or result['execution'] == 'INCOMPLETE':
        raise SystemExit(1)


if __name__ == '__main__':
    asyncio.run(main())
