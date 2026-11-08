"""Assemble enterprise execution from registered resources and a frozen version."""
from assets.runtime_skills import from_files, stats
from runtime.environments import EnvironmentStore, EnvironmentError, headers_for
from runtime.contracts import validate_skill_set
from runtime.launcher import RuntimeLauncher
from runtime.tool_environment import runtime_inputs
from tasks.values import fingerprint


async def describe_runtime(root, snapshot, configuration, services=(), *, managed=False, execution_mode=None, registry=None):
    registry = registry or EnvironmentStore(root)
    mode = execution_mode or configuration.get('executionMode')
    harness = configuration.get('harnessTools', [])
    if managed and (services or harness or configuration.get('runtimeToolConfig')):
        raise EnvironmentError('托管工作区只允许已准入的工具；整组自定义脚本、MCP 与 Harness 需要先由执行环境维护者接入', 403)
    selected = await registry.require_available(configuration['environmentId'])
    resolved = await registry.resolve_launcher(selected)
    launcher = resolved['launcher']
    probe = await registry.preflight(launcher)
    if probe['status'] != 'ready' or not probe.get('capabilities'):
        raise EnvironmentError('运行环境不可用', 409)
    capabilities = probe['capabilities']
    public, secrets = runtime_inputs(configuration)
    has_inputs = bool(public or secrets)
    def unsupported(message):
        error = EnvironmentError(message, 409)
        error.runtime_failure_snapshot = {'capabilities': capabilities}
        raise error
    if has_inputs and not capabilities['features'].get('toolEnvironment'):
        unsupported('所选环境尚不支持声明的工具配置，请选择支持该能力的环境；已填写内容会保留。')
    if not any(model['modelId'] == configuration['modelId'] for model in capabilities['models']):
        unsupported('运行环境不提供所选模型')
    if configuration['timeoutMs'] > capabilities['limits']['maxTimeoutMs']:
        unsupported('验收超时设置超过 Runtime 限制')
    if mode == 'agent_project' and not capabilities['features'].get('projectExecution'):
        unsupported('所选 Runtime 不支持完整 Agent 工程执行：FEATURE_UNAVAILABLE_projectExecution')
    skill_set = validate_skill_set({'executionMode': mode, 'skills': [], 'assets': snapshot['files'], 'contentDigest': snapshot['digest']}) if mode == 'agent_project' else from_files({
        **snapshot, **({'entryInstructionsFile': configuration['entryInstructionsFile']} if configuration.get('entryInstructionsFile') else {})})
    size = stats(skill_set)
    if size['bytes'] > capabilities['limits']['maxArchiveBytes'] or size['count'] > capabilities['limits']['maxFiles']:
        raise EnvironmentError('整组包超过目标 Runtime 的容量限制', 409)
    if configuration.get('entryInstructionsFile') and configuration['entryInstructionsFile'] not in snapshot['files']:
        raise EnvironmentError('Skill 入口文件不存在', 409)
    if services and not capabilities['features'].get('packagedMcp'):
        unsupported('Runtime 不支持候选中的共享 MCP 服务')
    if resolved['mcpEnvironmentIds'] and not capabilities['features'].get('externalMcp'):
        unsupported('Runtime 不支持绑定的外部 MCP 服务')
    mcp_servers, external_versions = [], []
    for identifier in resolved['mcpEnvironmentIds']:
        server = await registry.require_available(identifier)
        if server['type'] != 'mcp_streamable_http':
            raise EnvironmentError('外部工具绑定不是 MCP 服务', 409)
        external_versions.append({'id': identifier, 'updatedAt': server['updatedAt']})
        headers = headers_for(server)
        mcp_servers.append({'serverId': identifier, 'endpoint': server['endpoint'], 'transport': 'streamable_http', 'toolNames': [],
                            **({'secretHeaders': headers} if headers else {})})
    model = {'providerId': 'runtime-launcher', 'modelId': configuration['modelId'], 'parameters': {}}
    options = {'baseUrl': launcher['baseUrl'], 'headers': headers_for(launcher), 'side': 'right', 'model': model, 'skill': None,
        'variant': {'mode': 'skill_version', 'skillId': 'bundle', 'version': 'frozen', 'artifactSha256': snapshot['digest']},
        'skillSet': skill_set, 'environment': {'environmentId': configuration['environmentId'], 'harnessToolNames': harness,
            'availableToolNames': list(dict.fromkeys(name for service in services for name in service['toolNames'])),
            **({'runtimeToolConfig': configuration['runtimeToolConfig']} if configuration.get('runtimeToolConfig') else {}),
            'mcpServers': mcp_servers, 'candidateMcpServices': [{**service, 'assetDigest': snapshot['digest']} for service in services]},
        'timeoutMs': configuration['timeoutMs'], 'configuration': public, 'secrets': {'mode': 'inline', 'values': secrets}}
    environment = {'environmentId': selected['environmentId'], 'updatedAt': selected['updatedAt'], 'launcherId': launcher['environmentId'],
        'launcherUpdatedAt': launcher['updatedAt'], **({'delivery': launcher['delivery']} if launcher.get('delivery') else {}),
        'externalVersions': external_versions, 'capabilities': capabilities,
        **({'toolConfigurationDigest': fingerprint({**public, **secrets})} if has_inputs else {})}
    return {'options': options, 'model': model, 'environmentSnapshot': environment}


async def create_runtime(root, snapshot, configuration, services=(), **options):
    material = await describe_runtime(root, snapshot, configuration, services, **options)
    runtime = RuntimeLauncher(material['options'])
    from evaluation.external_traces import collector_for
    runtime.trace_collector = collector_for(root)
    return {**material, 'runtime': runtime}
