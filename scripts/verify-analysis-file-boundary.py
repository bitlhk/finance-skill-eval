"""Actual SDK file I/O against synthetic sibling files; no model or bank calls."""
import argparse
import asyncio
import json
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "integrations/openjiuwen"))
from analysis_file_tools import WorkspaceReadFileTool, WorkspaceGlobTool, WorkspaceListDirTool
from harness_tools import AbsoluteLineReadFileTool
from openjiuwen.core.sys_operation import SysOperation
from openjiuwen.core.sys_operation.base import OperationMode
from openjiuwen.core.sys_operation.sys_operation import SysOperationCard
from openjiuwen.harness.tools import GlobTool, ListDirTool


async def verify(legacy=False):
    with tempfile.TemporaryDirectory(prefix="analysis-boundary-probe-") as directory:
        parent = Path(directory)
        workspace = parent / "workspace"
        workspace.mkdir()
        (workspace / "SKILL.md").write_text("SYNTHETIC_OWN_METHOD")
        sibling = parent / "other"
        sibling.mkdir()
        marker = sibling / "synthetic-marker.txt"
        marker.write_text("SYNTHETIC_SIBLING_ONLY_926")
        operation = SysOperation(SysOperationCard(id="isolated-boundary-probe", mode=OperationMode.LOCAL))
        results = {}
        tools = [
            ("read", AbsoluteLineReadFileTool(operation) if legacy else WorkspaceReadFileTool(workspace, operation),
             {"file_path": str(marker)}),
            ("glob", GlobTool(operation) if legacy else WorkspaceGlobTool(workspace, operation),
             {"path": str(sibling), "pattern": "*.txt"}),
            ("list", ListDirTool(operation) if legacy else WorkspaceListDirTool(workspace, operation),
             {"path": str(sibling)}),
        ]
        for name, tool, arguments in tools:
            result = await asyncio.wait_for(tool.invoke(arguments), 15)
            own = {"file_path": str(workspace / "SKILL.md")} if name == "read" else {
                "path": str(workspace), "pattern": "*.md"}
            own_result = await asyncio.wait_for(tool.invoke(own), 15)
            results[name] = {
                "success": result.success,
                "syntheticMarkerVisible": "SYNTHETIC_SIBLING_ONLY_926" in str(result.data),
                "syntheticFilenameVisible": "synthetic-marker.txt" in str(result.data),
                "ownReadSucceeded": own_result.success,
            }
        report = {"scope": "SYNTHETIC_SIBLING_ONLY_NO_MODEL", "legacy": legacy, "tools": results}
        passed = all(row["ownReadSucceeded"] and row["success"] == legacy
                     and row["syntheticFilenameVisible"] == legacy for row in results.values())
        report["status"] = "PASS" if passed else "FAIL"
        return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--legacy", action="store_true", help="Reproduce old SDK wiring with synthetic files only")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = asyncio.run(verify(args.legacy))
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(report, stream, indent=2)
        stream.write("\n")
    print(json.dumps(report))
    raise SystemExit(0 if report["status"] == "PASS" else 1)
