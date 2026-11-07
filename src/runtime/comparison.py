"""Build fixed comparison runtimes from shared assets, registry and Launcher clients."""
from copy import deepcopy
import hashlib

from assets.library import AssetLibrary
from assets.requirements import runtime_requirements, describe
from runtime.basic import ReplayRuntime, DirectModelRuntime, OriginalServiceRuntime
from runtime.environments import EnvironmentStore, headers_for
from runtime.launcher import RuntimeLauncher
from runtime.models import configured_model_role
from runtime.tool_environment import runtime_inputs


async def comparison_runtimes(configuration, pack, workspace, *, registry=None):
    registry = registry or EnvironmentStore(workspace['dataDirectory'], workspace.get('launcherTrust'))
    library = AssetLibrary(workspace)
    kind = configuration['runtime']['type']
    if any(case.get('turns') for case in pack['cases']) and kind != 'runtime_launcher':
        raise ValueError('真实多轮案例必须通过支持多轮的 Runtime Launcher 执行')
    if kind == 'replay':
        if not all(case.get('replay') for case in pack['cases']):
            raise ValueError('所选用例没有提供冻结的回放证据')
        return {side: ReplayRuntime(pack) for side in ('left', 'right')}
    if kind == 'direct_model':
        execution = configured_model_role('EXECUTION')
        if not execution['adapter']:
            raise ValueError('本服务未配置执行模型')
        if not configuration.get('skillAssetId'):
            raise ValueError('直连模型运行需要先上传 Skill 资产')
        if any(case['requiredTools'] for case in pack['cases']):
            raise ValueError('这个测试需要工具，请选择 Agent Runtime HTTP 环境')
        return {side: DirectModelRuntime(execution['adapter'], await library.resolve(pack['variants'][side], configuration['skillAssetId'])) for side in ('left', 'right')}
    if kind != 'runtime_launcher':
        raise ValueError('Unsupported Runtime')
    runtimes, upstream_models = {}, []
    for side in ('left', 'right'):
        binding = (configuration.get('runtimeBindings') or {}).get(side)
        if side == 'left' and configuration['evaluationMode'] == 'service_comparison':
            variant = pack['variants']['left']
            if not variant.get('artifactSha256'):
                raise ValueError('原服务对比缺少源资产绑定')
            runtimes[side] = OriginalServiceRuntime(configuration['originalService'], variant['artifactSha256'])
            continue
        if side == 'left' and configuration['evaluationMode'] == 'candidate_assessment':
            continue
        environment_id = binding['environmentId'] if binding else configuration['runtime']['environmentId']
        selected = await registry.require_available(environment_id)
        resolved = await registry.resolve_launcher(selected)
        launcher = resolved['launcher']
        inspection = await registry.inspect(selected)
        if inspection['status'] != 'ready' or not inspection.get('capabilities'):
            raise ValueError(inspection.get('error') or '执行环境预检失败')
        capabilities = inspection['capabilities']
        model = next((model for model in capabilities['models'] if model['modelId'] == pack['models']['execution'][side]['modelId']), None)
        if not model:
            raise ValueError('所选模型不属于这个执行环境')
        upstream_models.append(model['upstreamModelId'])
        source = await library.resolve(pack['variants'][side], binding['skillAssetId'] if binding else configuration.get('skillAssetId'), strict=bool(binding))
        required = runtime_requirements(source['instructions'] if source else None,
            [name for case in pack['cases'] for name in case['requiredTools']], capabilities.get('auxiliaryToolNames', []))
        scripts = (configuration.get('runtimeCommandBindings') or {}).get(side, [])
        services = deepcopy((configuration.get('runtimeMcpBindings') or {}).get(side, []))
        for service in services:
            if pack['variants'][side]['mode'] != 'skill_version' or service['assetDigest'] != pack['variants'][side].get('artifactSha256'):
                raise ValueError('Candidate MCP asset digest does not match the bound Skill')
            reference = service.pop('environmentReference', None)
            if reference:
                from runtime.service_environment import resolve_service_environment
                if reference['assetDigest'] != service['assetDigest']:
                    raise ValueError('服务配置与候选资产不一致')
                values = await resolve_service_environment(workspace['dataDirectory'], reference, service['toolNames'])
                service.update(environment=values['configuration'], secretEnvironment=values['secrets'])
        if source:
            for name in [path for script in scripts for path in [script['path'], *script.get('filePaths', [])]] + [path for service in services for path in service['filePaths']]:
                if name not in source['archive']:
                    raise ValueError('Bound Tool file is unavailable: ' + name)
        harness = configuration.get('runtimeHarnessTools', [])
        candidate_names = {name for service in services for name in service['toolNames']}
        script_names = {tool['name'] for tool in scripts}
        native_names = set(capabilities.get('nativeToolNames', []))
        external_required = set(required) - candidate_names - script_names - native_names - set(harness) - {'skill_tool'}
        servers, available = [], set()
        if external_required:
            for identifier in resolved['mcpEnvironmentIds']:
                server = await registry.require_available(identifier)
                if server['type'] != 'mcp_streamable_http':
                    raise ValueError('MCP environment is unavailable: ' + identifier)
                preflight = await registry.preflight(server)
                if preflight['status'] != 'ready':
                    raise ValueError('MCP preflight failed for ' + server['name'])
                names = [tool['name'] for tool in preflight['tools'] if tool['name'] in external_required]
                if names:
                    available.update(names)
                    servers.append({'serverId': identifier, 'endpoint': server['endpoint'], 'transport': 'streamable_http',
                        'toolNames': names, 'credentialEnv': server.get('credentialEnv'), **({'secretHeaders': headers_for(server)} if headers_for(server) else {})})
        missing = external_required - available
        if missing:
            raise ValueError('Required MCP tools are unavailable: ' + ', '.join(sorted(missing)))
        # An imported Skill may have no allowed-tools list. Explicitly selected
        # delivery bindings are still available for the Agent to choose from;
        # test cases need not prescribe the tools that produce their answers.
        expose_all = bool(binding and (pack.get('metadata', {}).get('assessmentMode') == 'natural_language'
            or source and describe(source['instructions'])['status'] == 'unspecified'))
        descriptor = {'environmentId': environment_id, 'requiredToolNames': required, 'harnessToolNames': harness,
            **({'availableToolNames': sorted(candidate_names | script_names)} if expose_all else {}), 'mcpServers': servers,
            'commandScripts': [tool for tool in scripts if expose_all or tool['name'] in required],
            'candidateMcpServices': [service for service in services if expose_all or any(name in required for name in service['toolNames'])],
            **({'runtimeToolConfig': configuration['runtimeToolConfig']} if configuration.get('runtimeToolConfig') else {})}
        public, secrets = runtime_inputs(binding or {})
        if (public or secrets) and not capabilities['features'].get('toolEnvironment'):
            raise ValueError('所选 Runtime 不支持声明的工具配置，请选择支持 toolEnvironment 的环境')
        if workspace.get('managedWorkspace') and (scripts or services or harness or configuration.get('runtimeToolConfig')):
            raise ValueError('托管工作区只允许已准入的工具和运行配置')
        skill_set = source['skillSet'] if source else {'skills': [], 'contentDigest': hashlib.sha256(b'').hexdigest()}
        # Public bindings identify the verified asset in its stored file order.
        # The Launcher validates the mounted collection's canonical digest.
        # Translate only after resolving/checking the asset above: these two
        # representations intentionally have different identities.
        for service in descriptor['candidateMcpServices']:
            service['assetDigest'] = skill_set['contentDigest']
        runtimes[side] = RuntimeLauncher({'baseUrl': launcher['baseUrl'], 'headers': headers_for(launcher), 'side': side,
            'model': pack['models']['execution'][side], 'variant': pack['variants'][side], 'skill': None, 'skillSet': skill_set,
            'environment': descriptor, 'configuration': public, 'secrets': {'mode': 'inline', 'values': secrets},
            'timeoutMs': configuration['timeoutMs'], 'stopAfterFailure': configuration['evaluationMode'] == 'candidate_runtime_comparison'})
    if configuration['evaluationMode'] == 'candidate_runtime_comparison' and len(set(upstream_models)) != 1:
        raise ValueError('跨 Runtime 对照必须使用相同的真实执行模型')
    from evaluation.external_traces import collector_for
    for runtime in runtimes.values():
        runtime.trace_collector = collector_for(workspace['dataDirectory'])
    return runtimes
