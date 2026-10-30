"""Source runtime context; business files are relative to a caller-owned workspace."""
import json
from pathlib import Path


class LegacyContext:
    def __init__(self, workspace):
        self.workspace = Path(workspace).resolve()

    def read_json(self, relative_path):
        file = (self.workspace / relative_path).resolve()
        if self.workspace not in file.parents:
            raise ValueError("Data must stay in the business workspace")
        return json.loads(file.read_text(encoding="utf-8"))
