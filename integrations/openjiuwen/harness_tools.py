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
