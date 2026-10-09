"""SDK delegation is allowed only after a per-invocation path check."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from integrations.openjiuwen.analysis_file_tools import (
    WorkspaceReadFileTool, WorkspaceGlobTool, WorkspaceListDirTool,
)
from integrations.openjiuwen.harness_tools import AbsoluteLineReadFileTool
from openjiuwen.harness.tools import GlobTool, ListDirTool
from openjiuwen.harness.tools.base_tool import ToolOutput
from integrations.openjiuwen.migration_tools import _readable_files, build_grep_tool


class AnalysisFileBoundaryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.parent = Path(self.directory.name)
        self.root = self.parent / "workspace"
        self.root.mkdir()
        (self.root / "SKILL.md").write_text("APPROVED_SYNTHETIC_METHOD")
        self.other = self.parent / "other"
        self.other.mkdir()
        (self.other / "private.txt").write_text("SYNTHETIC_OTHER_ACCOUNT_MARKER")

    async def call(self, kind, inputs, allowed=False):
        cls, base = {"read": (WorkspaceReadFileTool, AbsoluteLineReadFileTool),
                     "glob": (WorkspaceGlobTool, GlobTool),
                     "list": (WorkspaceListDirTool, ListDirTool)}[kind]
        delegated = AsyncMock(return_value=ToolOutput(success=True, data="SYNTHETIC_OK"))
        with patch.object(base, "invoke", delegated):
            tool = cls(self.root, None)
            result = await tool.invoke(inputs)
        self.assertEqual(delegated.await_count, int(allowed))
        self.assertEqual(result.success, allowed)
        return delegated

    async def test_absolute_sibling_paths_blocked_before_sdk_io(self):
        for kind, args in [("read", {"file_path": str(self.other / "private.txt")}),
                           ("glob", {"path": str(self.other), "pattern": "*.txt"}),
                           ("list", {"path": str(self.other)})]:
            with self.subTest(kind=kind):
                await self.call(kind, args)

    async def test_relative_traversal_blocked(self):
        await self.call("read", {"file_path": "../other/private.txt"})
        await self.call("list", {"path": "../other"})
        await self.call("glob", {"path": "../other", "pattern": "*"})

    async def test_glob_patterns_cannot_escape_even_with_inside_base(self):
        for pattern in ["../other/*", str(self.other / "*"), "{*.md,../other/*}", "..\\other\\*", "C:/other/*"]:
            with self.subTest(pattern=pattern):
                await self.call("glob", {"pattern": pattern})

    async def test_symlink_is_never_followed(self):
        (self.root / "link").symlink_to(self.other, target_is_directory=True)
        await self.call("read", {"file_path": "link/private.txt"})
        await self.call("list", {"path": "."})
        await self.call("glob", {"pattern": "**/*"})

    async def test_missing_paths_do_not_default_to_process_directory(self):
        for kind, args in [("list", {}), ("glob", {"pattern": "*.md"})]:
            delegated = await self.call(kind, args, True)
            self.assertEqual(delegated.call_args.args[0]["path"], str(self.root))

    async def test_inside_reads_preserve_options_and_tool_card(self):
        delegated = await self.call("read", {"file_path": "SKILL.md", "offset": 1, "limit": 2}, True)
        self.assertEqual(delegated.call_args.args[0], {"file_path": str(self.root / "SKILL.md"), "offset": 1, "limit": 2})
        await self.call("glob", {"path": str(self.root), "pattern": "**/*.{md,txt}"}, True)
        await self.call("list", {"path": str(self.root), "show_hidden": True}, True)

    async def test_invalid_input_is_rejected(self):
        await self.call("read", {"file_path": 7})
        await self.call("glob", {"pattern": ["*.md"]})
        await self.call("list", {"path": "bad\x00path"})

    async def test_grep_and_scanner_inputs_skip_symlink_files(self):
        (self.root / "link.txt").symlink_to(self.other / "private.txt")
        files = list(_readable_files(self.root, self.root))
        self.assertEqual([p.name for p, _ in files], ["SKILL.md"])
        self.assertNotIn("SYNTHETIC_OTHER_ACCOUNT_MARKER", str(files))

    async def test_grep_one_file_preserves_normal_analysis(self):
        tool = build_grep_tool(self.root)
        result = await tool.invoke({"path": str(self.root / "SKILL.md"), "pattern": "APPROVED"})
        self.assertIn("APPROVED_SYNTHETIC_METHOD", str(result))
        denied = await tool.invoke({"path": str(self.other / "private.txt"), "pattern": "SYNTHETIC"})
        self.assertIn("SEARCH_OUTSIDE_WORKSPACE", str(denied))
        self.assertNotIn("SYNTHETIC_OTHER_ACCOUNT_MARKER", str(denied))


if __name__ == "__main__":
    unittest.main()
