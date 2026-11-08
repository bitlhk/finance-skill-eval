"""Workspace-bound adapters for the analysis agent's existing SDK file tools."""
from pathlib import Path

from openjiuwen.harness.tools import GlobTool, ListDirTool
from openjiuwen.harness.tools.base_tool import ToolOutput

try:
    from .harness_tools import AbsoluteLineReadFileTool
except ImportError:
    from harness_tools import AbsoluteLineReadFileTool


try:
    from .workspace_paths import analysis_path, check_analysis_tree
except ImportError:
    from workspace_paths import analysis_path, check_analysis_tree


class WorkspaceReadFileTool(AbsoluteLineReadFileTool):
    def __init__(self, workspace, *args, **kwargs):
        self.workspace = Path(workspace).resolve()
        super().__init__(*args, **kwargs)
        self.card.description = ('读取当前任务工作区中的文件，优先使用 source/...、candidate/...、task/... 相对路径；'
            '也接受工作区内绝对路径，不需要拼接 Windows 长路径。返回内容保留原始行号，大文件可用 offset/limit 分段读取。只能读取文件，目录请用 list_files 或 glob。')
        self.card.input_params['properties']['file_path']['description'] = '工作区相对文件路径（推荐），或工作区内的绝对文件路径'

    async def invoke(self, inputs, **kwargs):
        try:
            target = analysis_path(self.workspace, inputs.get("file_path", ""))
            check_analysis_tree(self.workspace)
        except (ValueError, OSError, RuntimeError) as error:
            return ToolOutput(success=False, error=str(error))
        return await super().invoke({**inputs, "file_path": str(target)}, **kwargs)


class WorkspaceGlobTool(GlobTool):
    def __init__(self, workspace, *args, **kwargs):
        self.workspace = Path(workspace).resolve()
        super().__init__(*args, **kwargs)

    async def invoke(self, inputs, **kwargs):
        try:
            target = analysis_path(self.workspace, inputs.get("path", ""))
            pattern = inputs.get("pattern", "")
            if not isinstance(pattern, str):
                raise ValueError("ANALYSIS_PATTERN_INVALID")
            for expanded in self._expand_brace_pattern(pattern):
                parts = expanded.replace("\\", "/").split("/")
                if Path(expanded).is_absolute() or ".." in parts or ":" in expanded:
                    raise ValueError("ANALYSIS_PATTERN_OUTSIDE_WORKSPACE")
            check_analysis_tree(self.workspace)
        except (ValueError, OSError, RuntimeError) as error:
            return ToolOutput(success=False, error=str(error))
        return await super().invoke({**inputs, "path": str(target)}, **kwargs)


class WorkspaceListDirTool(ListDirTool):
    def __init__(self, workspace, *args, **kwargs):
        self.workspace = Path(workspace).resolve()
        super().__init__(*args, **kwargs)

    async def invoke(self, inputs, **kwargs):
        try:
            target = analysis_path(self.workspace, inputs.get("path", ""))
            check_analysis_tree(self.workspace)
        except (ValueError, OSError, RuntimeError) as error:
            return ToolOutput(success=False, error=str(error))
        return await super().invoke({**inputs, "path": str(target)}, **kwargs)
