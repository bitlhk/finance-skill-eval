"""Harness tools, with the one correction our agents need.

`ReadFileTool` does number the lines it returns -- `_cat_n()` renders `f"{idx:>6}\\t{line}"`. The
problem is *what* it numbers: it reads a window (`line_range=(offset+1, ...)`) and then numbers
that window from 1. So a read at offset 5 answers with

        1	line 6
        2	line 7

i.e. it tells the model that file line 6 is line 1. Verified by reading a 20-line file at
offset=5, limit=3: the fs layer was asked for lines [6,8] and the tool labelled them 1,2,3.

That is exactly the shape that produced a citation of "line 25" in a 19-line SKILL.md: the model
was not miscounting, it was faithfully copying numbers that do not refer to the file. The platform
no longer depends on those numbers -- claims are located by the text they quote -- but a number
that is wrong is still a number the agent will reason from, and any claim that arrives without a
quote has nothing else to go on.

So: same tool, numbers that refer to the file.
"""

from __future__ import annotations

import re
from pathlib import Path

#: The rule package the platform ships with the agents. Both agents read their judgement rules from
#: it, and it is the reason `skill_rail` exists (see below).
SKILL_PACKAGE = str(Path(__file__).resolve().parents[2] / "skills")

from openjiuwen.core.single_agent.rail.base import AgentRail
from openjiuwen.harness.rails.sys_operation_rail import SysOperationRail
from openjiuwen.harness.tools import ReadFileTool

# The numbered form is exactly `_cat_n`'s: right-aligned to width 6, a tab, then the line. Anchored
# that tightly on purpose -- a file whose own content starts with `123\t` must not be renumbered.
_NUMBERED_LINE = re.compile(r"^(?P<prefix> *\d+)\t", re.MULTILINE)
_NUMBER_WIDTH = 6


def shift_line_numbers(rendered: str, offset: int) -> str:
    """Re-base window-relative numbers onto the file's own lines.

    Only numbered lines are touched: the tool also returns plain sentences (an empty read, an
    offset past the end), and those must come through as they are.
    """
    if offset <= 0:
        return rendered

    def renumber(match: re.Match[str]) -> str:
        prefix = match.group("prefix")
        if len(prefix) != _NUMBER_WIDTH:
            return match.group(0)
        return f"{int(prefix) + offset:>6}\t"

    return _NUMBERED_LINE.sub(renumber, rendered)


class AbsoluteLineReadFileTool(ReadFileTool):
    """`ReadFileTool` with line numbers that match the file, and a description that says so.

    The harness's own description says only that results "come with line numbers". It never says
    whose, and for a windowed read they were the window's -- so the one thing the agent needs to
    know in order to quote a line was both unstated and, until the fix above, untrue.
    """

    _DESCRIPTION = {
        "cn": (
            "从本地文件系统读取文件。file_path 必须是绝对路径。"
            "返回内容每行左侧的数字是**该行在文件中的行号**——要引用某一行就照抄它，不要自己数。"
            "默认从文件开头读最多 2000 行；用 offset/limit 读大文件的某一段时，行号仍按文件编，不从 1 开始。"
            "支持图片、PDF 和 Jupyter Notebook。只能读取文件，不能读取目录。"
            "大文件请用 offset/limit 读取指定部分，或用 grep 搜索具体内容。"
        ),
        "en": (
            "Read a file from the local filesystem. file_path must be an absolute path. "
            "The number to the left of each line is that line's number in the file -- copy it when "
            "citing a line rather than counting. By default, reads up to 2000 lines from the "
            "beginning; with offset/limit the numbers still refer to the file, not to the window. "
            "Supports images, PDFs, and Jupyter notebooks. Can read files only, not directories. "
            "For large files, use offset/limit to read a specific portion, or use grep to search for specific content."
        ),
    }

    def __init__(self, operation, language: str = "cn", agent_id: str | None = None,
                 enable_image_multimodal: bool = True) -> None:
        super().__init__(operation, language, agent_id, enable_image_multimodal)
        self._card = self._card.model_copy(
            update={"description": self._DESCRIPTION.get(language, self._DESCRIPTION["cn"])})

    async def _read_text(self, file_path: str, offset: int, limit: int, apply_size_cap: bool = True) -> str:
        rendered = await super()._read_text(file_path, offset, limit, apply_size_cap)
        return shift_line_numbers(rendered, max(0, int(offset)))


def skill_rail():
    """A `SkillUseRail` that is actually pointed at our skill package.

    The factory's `skills=` argument only decides *whether* to mount this rail; it never tells the
    rail where the package is -- the rail reads its directories from `skills_dir`, which the factory
    fills from the *workspace's* `skills/` node. That directory holds the harness's own bookkeeping,
    so `skill_tool` answered "Skill not found" for every name the agent tried, including the right
    one, and the rules it was told to consult were never reachable.

    Built here instead, with `skills_dir` set to the package the platform ships. `include_tools`
    is off because the agents already assemble their own file tools (and `FilesystemOnlyRail`
    declares the filesystem rail present, which is what that flag checks).
    """
    from openjiuwen.harness.rails.skills.skill_use_rail import SkillUseRail

    return SkillUseRail(skills_dir=[SKILL_PACKAGE], skill_mode="all", include_tools=False)


def _short(value, limit: int = 200) -> str:
    """One readable line for a tool's arguments, whatever shape they arrive in."""
    import json

    try:
        text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        text = str(value)
    return text[:limit]


class ToolTraceRail(AgentRail):
    """The platform's own record of what the agent did, round by round.

    The trace used to be whatever the model wrote into its result JSON, which is the same mistake as
    asking it for line numbers: a self-report is not evidence, and it is missing exactly when the run
    fails. When a run burns its whole iteration budget the interesting question is *what it spent the
    rounds on*, and only the harness knows that. So the harness is asked, through the lifecycle hook
    that exists for it.
    """

    def __init__(self, capture: list[dict]) -> None:
        self.capture = capture

    async def after_tool_call(self, ctx) -> None:  # noqa: ANN001 - harness type
        inputs = getattr(ctx, "inputs", None)
        name = str(getattr(inputs, "tool_name", "") or "")
        if not name or name == "compile_source" or name == "run_contract_test":
            # Those two record themselves, with the outcome that matters (passed/failed and why).
            return
        # The arguments, not just the name: "read_file five times" says nothing about whether the
        # agent read five files or one file five times, and that difference is the whole question
        # when a run spends more rounds than the package has files.
        entry: dict = {"tool": name}
        args = getattr(inputs, "tool_args", None)
        if args:
            entry["args"] = _short(args)
        # The outcome, because a call that failed explains the one after it: an agent that retries a
        # name three ways is either guessing or reacting to an error, and the call list alone cannot
        # tell those apart.
        result = getattr(inputs, "tool_result", None)
        outcome = getattr(result, "success", None)
        if outcome is False:
            entry["failed"] = _short(getattr(result, "error", "") or "no reason given", 160)
        elif outcome is True:
            entry["ok"] = True
        self.capture.append(entry)

    async def on_tool_exception(self, ctx) -> None:  # noqa: ANN001 - harness type
        inputs = getattr(ctx, "inputs", None)
        name = str(getattr(inputs, "tool_name", "") or "")
        detail = str(getattr(ctx, "exception", "") or "")
        if name:
            self.capture.append({"tool": name, "failed": True, "detail": detail[:600]})


class FilesystemOnlyRail(SysOperationRail):
    """Says "the filesystem tools are already here" -- and provides none itself.

    This exists because the harness has no filesystem-only mode, and both ways a shell gets in key
    off the *type* of the rails list rather than on anything we can configure:

    * `SysOperationRail` always registers `bash` -- `shared = [glob, list_dir, grep, bash]` is
      built the same way in read-only mode, and Windows adds a powershell tool on top;
    * when no rail of that type is mounted, `SkillUseRail` registers its own `bash` as well
      ("so skills can do file/shell ops"), and it does that at *refresh* time, after the agent is
      built -- which is why removing the tool after construction does not work.

    Mounting this type satisfies both checks (`include_tools = not _already_provided(
    SysOperationRail)`), so neither one registers a shell.

    It registers nothing on purpose: the agents assemble their own file tools, including a
    `ReadFileTool` subclass whose line numbers match the file. Letting a rail register the stock
    `read_file` would quietly undo that fix.
    """

    priority = 100

    def __init__(self) -> None:
        super().__init__(read_only=True)
        self.tools = []

    def init(self, agent) -> None:  # noqa: ANN001 - harness type
        """Deliberately empty. The tools come from the agent's own `tools=` list."""

    def uninit(self, agent) -> None:  # noqa: ANN001 - harness type
        """Nothing was registered, so there is nothing to remove."""
