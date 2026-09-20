"""Framework Skill loading and explicitly requested Harness tools."""
import tempfile
import json
import sys
import shutil
from pathlib import Path


async def mount_skill_runtime(agent, stack, skill, root_path, workspace_path, requested, observe=None, *, plugins=None, artifact_digest=None, observe_start=None):
    from openjiuwen.core.sys_operation import SysOperation
    from openjiuwen.core.sys_operation.base import OperationMode
    from openjiuwen.core.sys_operation.config import LocalWorkConfig
    from openjiuwen.core.sys_operation.cwd import init_cwd
    from openjiuwen.core.sys_operation.sys_operation import SysOperationCard
    from openjiuwen.harness.rails.skills.skill_use_rail import SkillUseRail
    from openjiuwen.harness.tools import BashTool, GlobTool, ListDirTool, ReadFileTool
    from openjiuwen.core.single_agent.rail.base import AgentRail

    factories = {'bash': BashTool, 'glob': GlobTool, 'list_files': ListDirTool, 'read_file': ReadFileTool}
    if set(requested) - factories.keys():
        raise ValueError('Unsupported requested Harness capability')
    selected = set(requested) & factories.keys()
    library = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix='finance-skill-library-')))
    directory = library / 'target-skill'
    plugin_files = {name for binding in plugins or [] for name in binding.get('filePaths', [])}
    if skill:
        directory.mkdir()
        for name, content in skill.get('files', {}).items():
            if name in plugin_files:
                continue
            target = (directory / name.replace('\\', '/')).resolve()
            if directory.resolve() not in target.parents:
                raise ValueError('Unsafe Skill resource path')
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding='utf-8')
        # The canonical source is already supplied by the asset store. Keep the complete
        # package beside it so reference paths remain package-relative.
        (directory / 'SKILL.md').write_text(skill['instructions'], encoding='utf-8')
    shell_programs = {'python', 'python3', 'uv', 'node', sys.executable}
    shell_programs.update(path for name in ('python', 'python3', 'uv', 'node') if (path := shutil.which(name)))
    # The pinned shell checks the literal first token. Cover resolved interpreter
    # spelling and quotes without opening a new executable category.
    shell_programs.update(quoted for path in list(shell_programs) if not any(char.isspace() for char in path)
        for quoted in ('"' + path + '"', "'" + path + "'"))
    operation = SysOperation(SysOperationCard(id=agent.card.id, mode=OperationMode.LOCAL,
        work_config=LocalWorkConfig(restrict_to_sandbox=True,
            sandbox_root=[str(workspace_path), str(root_path), str(library)],
            shell_allowlist=sorted(shell_programs) if 'bash' in selected else [])))
    init_cwd(str(workspace_path), project_root=str(root_path), workspace=str(workspace_path))
    if hasattr(agent, 'deep_config'):
        agent.deep_config.sys_operation = operation
        agent.deep_config.cwd = str(workspace_path)
        agent.deep_config.project_root = str(root_path)
        agent.react_agent.config.sys_operation_id = operation.id
    else:
        # Compatibility for independently constructed core agents.
        agent.system_prompt_builder = agent.prompt_builder
    for name in sorted(selected):
        tool = factories[name](operation, language='cn', agent_id=agent.card.id)
        if agent.ability_manager.get(tool.card.name) is not None:
            raise ValueError(f'Ambiguous Harness tool: {tool.card.name}')
        agent.ability_manager.add_ability(tool.card, tool)
    if skill:
        rail = SkillUseRail(skills_dir=[str(library)], enabled_skills=['target-skill'],
            skill_mode='all', include_tools=False)
        rail.set_sys_operation(operation)
        await agent.register_rail(rail)
        await rail.reload_skills()
        if len(rail.skills_meta) != 1:
            raise ValueError('SkillUseRail did not load the requested Skill')
    plugin_names = set()
    for binding in plugins or []:
        if not skill or binding.get('assetDigest') != skill.get('artifactSha256') or binding.get('assetDigest') != artifact_digest:
            raise ValueError('Harness plugin digest does not match the loaded artifact')
        names = set(binding.get('toolNames', []))
        paths = binding.get('filePaths', [])
        manifest = binding.get('manifestPath')
        if not names or not isinstance(manifest, str) or manifest not in paths:
            raise ValueError('Harness plugin requires tool names and a declared manifest')
        if names & (selected | plugin_names | {'skill_tool', 'list_skill'}) or any(agent.ability_manager.get(name) is not None for name in names):
            raise ValueError('Ambiguous Harness plugin tool')
        package = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix='finance-harness-plugin-'))).resolve()
        for name in paths:
            target = (package / name.replace('\\', '/')).resolve()
            if package not in target.parents or name not in skill.get('files', {}):
                raise ValueError('Harness plugin file is unavailable or unsafe')
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(skill['files'][name], encoding='utf-8')
        payload = json.loads((package / manifest).read_text(encoding='utf-8'))
        if payload.get('skills') or payload.get('mcps'):
            raise ValueError('Harness plugins may not load undeclared Skills or MCP services')
        previous_names = {card.name for card in agent.ability_manager.list()}
        record = await agent.load_plugin(str(package / manifest))
        loaded_names = {card.name for card in agent.ability_manager.list()} - previous_names
        if loaded_names != names or len([ref for ref in record.refs if ref.kind.value == 'tool']) != len(names):
            await agent.unload_extension(record)
            raise ValueError('Harness plugin tools do not match their declared names')
        plugin_names.update(names)
    selected.update(plugin_names)
    if observe:
        class EvidenceRail(AgentRail):
            async def before_tool_call(self, ctx):
                if observe_start and ctx.inputs.tool_name in selected | {'skill_tool'}:
                    observe_start(ctx.inputs.tool_name)
            async def after_tool_call(self, ctx):
                inputs = ctx.inputs
                if inputs.tool_name in selected | {'skill_tool'}:
                    result = inputs.tool_result
                    if getattr(ctx, 'exception', None) is not None:
                        result = {'status': 'unavailable', 'error': type(ctx.exception).__name__}
                    arguments = inputs.tool_args
                    if isinstance(arguments, str):
                        try:
                            arguments = json.loads(arguments)
                        except ValueError:
                            pass
                    observe(inputs.tool_name, arguments, result)
        await agent.register_rail(EvidenceRail())
    return selected
