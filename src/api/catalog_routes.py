"""Existing catalog and dataset preparation endpoints, with no TS callbacks."""
import asyncio
from fastapi import Request, HTTPException

from assets.store import execute as assets
from assets.requirements import describe
from evaluation.packs import EvalPackCatalog, PreparationStore, suite_cases
from evaluation.case_generation import generate_cases
from runtime.models import configured_model_role
from runtime.environments import EnvironmentStore
from .contracts import parse


def asset_call(context, action, **fields):
    return assets({'root': context['dataDirectory'], 'legacyOrderIndex': context['legacyOrderIndex'], 'action': action, **fields})


def install_catalog_routes(app):
    @app.get('/api/catalog')
    async def catalog(request: Request):
        context = request.state.workspace
        registry = EnvironmentStore(context['dataDirectory'], context.get('launcherTrust'))
        saved = await registry.list(True)
        active = [item for item in saved if not item['archived']]
        executions = [item for item in active if item['type'] == 'execution_environment']
        referenced = {item['launcherEnvironmentId'] for item in executions}
        selected = executions + [item for item in active if item['type'] == 'runtime_launcher' and item['environmentId'] not in referenced]
        async def inspect(record):
            try:
                resolved, inspection = await registry.resolve_launcher(record), await registry.inspect(record)
                if inspection['status'] != 'ready' or not inspection.get('capabilities'):
                    return None
                capabilities = inspection['capabilities']
                launcher, identifier = resolved['launcher'], record['environmentId']
                return {'runtimeId': identifier, 'launcherEnvironmentId': launcher['environmentId'], 'name': record['name'],
                    'runtimeType': launcher['runtimeType'], 'endpoint': launcher['baseUrl'], 'mcpEnvironmentIds': resolved['mcpEnvironmentIds'],
                    'toolCount': inspection['toolCount'], 'inspection': inspection, 'transport': 'runtime_launcher',
                    'defaultModelId': resolved['defaultModelId'] or capabilities['defaultModelId'],
                    **({'supportedSkillModes': capabilities['supportedSkillModes']} if 'supportedSkillModes' in capabilities else {}),
                    'models': [{'providerId': 'runtime-launcher:' + identifier, 'modelId': model['modelId'], 'upstreamModelId': model['upstreamModelId'],
                        'label': model.get('label', model['upstreamModelId']), 'parameters': {}, 'availability': 'ready', 'statusNote': '由 Runtime Launcher capabilities 提供'} for model in capabilities['models']]}
            except Exception:
                return None
        runtimes = [item for item in await asyncio.gather(*(inspect(item) for item in selected)) if item]
        def load():
            pack_catalog = EvalPackCatalog(context['rootDirectory'])
            asset_call(context, 'initialize')
            uploaded = asset_call(context, 'list')
            for item in uploaded:
                try:
                    item['runtimeRequirements'] = describe(asset_call(context, 'readSource', id=item['assetId']))
                except (ValueError, OSError):
                    item['runtimeRequirements'] = {'status': 'invalid', 'tools': [], 'error': '无法读取该版本 Skill 声明'}
            preparations = PreparationStore(context['dataDirectory']).list()
            for preparation in preparations:
                preparation['deterministicReady'] = bool(preparation['cases']) and all(case['rubric'] and all(rule['allOf'] or rule['anyOf'] or rule['noneOf'] for rule in case['rubric']) for case in preparation['cases'])
            featured = pack_catalog.featured(bool(runtimes))
            for skill in featured:
                if skill['evaluationStatus'] != 'pack_required':
                    skill['evaluationStatus'] = 'ready' if runtimes and any(item['skillId'] == skill['skillId'] for item in uploaded) else 'environment_required'
            return uploaded, preparations, featured, pack_catalog.list()
        uploaded, preparations, featured, packs = await asyncio.to_thread(load)
        roles = {role.lower(): {key: value for key, value in configured_model_role(role).items() if key != 'adapter'}
                 for role in ('ANALYZER', 'EXECUTION', 'JUDGE', 'OPTIMIZER')}
        roles['directExecution'] = roles['execution']
        roles['execution'] = {'configured': bool(runtimes), 'model': next((model for model in runtimes[0]['models'] if model['modelId'] == runtimes[0]['defaultModelId']), roles['directExecution']['model']) if runtimes else roles['directExecution']['model']}
        return {'schemaVersion': 'finance.skill-eval.catalog.v1', 'serviceVersion': '0.5.1',
            'publicDemo': bool(context['publicDemo']), 'managedWorkspace': bool(context['managedWorkspace']),
            'featuredSkills': featured, 'evalPacks': packs, 'uploadedSkills': uploaded, 'preparations': preparations,
            'environments': saved, 'executionRuntimes': runtimes,
            'launcherTrustReferences': [{key: item[key] for key in ('reference', 'label', 'baseUrlPrefix')} for item in context['launcherTrust']],
            'runtimes': [
                {'id': 'replay', 'label': '冻结证据回放', 'status': 'ready', 'realExecution': False, 'description': '复核已固化的真实或受控运行证据，不重新调用 Agent。'},
                {'id': 'direct_model', 'label': '文本 Skill 直测', 'status': 'ready' if roles['directExecution']['configured'] else 'configuration_required',
                 'realExecution': True, 'description': '适合不依赖工具的 Skill；同一模型分别在无 Skill 与装配 Skill 条件下执行。'},
                {'id': 'runtime_launcher', 'label': '在线执行环境', 'status': 'ready' if runtimes else 'configuration_required',
                 'realExecution': True, 'description': '由 Runtime Launcher 启动隔离实例，并按执行环境装配模型与 MCP。'}], 'modelRoles': roles}

    async def prepare(request, identifier, mode):
        context = request.state.workspace
        skill = await asyncio.to_thread(asset_call, context, 'get', id=identifier)
        if not skill:
            raise HTTPException(404, 'Skill asset not found')
        body = await request.json()
        if mode == 'manual':
            parsed = parse('manual_preparation', body)
            values = {'summary': parsed['summary'], 'cases': parsed['cases'], 'holdout': parsed.get('holdoutCases', []), 'source': 'manual'}
        elif mode == 'import':
            parsed = parse('migration_suite', body)
            values = {'summary': parsed['name'], 'cases': suite_cases(parsed), 'holdout': suite_cases(parsed, holdout=True), 'source': 'manual'}
        else:
            parsed = parse('prepare_skill', body)
            source = await asyncio.to_thread(asset_call, context, 'readSource', id=identifier)
            generated = await generate_cases({**parsed, 'skillId': skill['skillId'], 'skillSource': source, 'count': parsed['maximumCases']})
            values = {'summary': generated['summary'], 'cases': generated['cases'], 'source': 'ai_generated', 'context': generated['evaluationContext']}
        return await asyncio.to_thread(PreparationStore(context['dataDirectory']).create, skill, **values)

    @app.post('/api/skills/{identifier}/prepare')
    async def generate(identifier: str, request: Request):
        return await prepare(request, identifier, 'ai')

    @app.post('/api/skills/{identifier}/prepare/manual')
    async def manual(identifier: str, request: Request):
        return await prepare(request, identifier, 'manual')

    @app.post('/api/skills/{identifier}/prepare/import')
    async def imported(identifier: str, request: Request):
        return await prepare(request, identifier, 'import')
