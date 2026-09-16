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
    """`ReadFileTool` with line numbers that match the file."""

    async def _read_text(self, file_path: str, offset: int, limit: int, apply_size_cap: bool = True) -> str:
        rendered = await super()._read_text(file_path, offset, limit, apply_size_cap)
        return shift_line_numbers(rendered, max(0, int(offset)))
