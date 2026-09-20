import unittest
import shutil
from integrations.openjiuwen.agent_protocol import build_workspace

class AnalysisWorkspaceTests(unittest.TestCase):
    def test_text_view_uses_lf_but_source_input_stays_original(self):
        original = b"# header\r\ndef run():\r    return 1\n"
        inputs = {"scripts/code.py": original, "SKILL.md": "one\r\ntwo\r"}
        root = build_workspace(inputs, normalize_text=True)
        try:
            self.assertEqual((root / "scripts/code.py").read_bytes(), b"# header\ndef run():\n    return 1\n")
            self.assertEqual((root / "SKILL.md").read_bytes(), b"one\ntwo\n")
            self.assertEqual(inputs["scripts/code.py"], original)
        finally:
            shutil.rmtree(root)

    def test_binary_unknown_extension_and_invalid_utf8_stay_byte_exact(self):
        files = {"assets/data.bin": b"a\r\nb\r", "assets/picture.png": b"\x89PNG\x00\r\n", "scripts/legacy.py": b"\xff\r\n", "assets/zero.txt": b"a\x00\r\nb"}
        root = build_workspace(files, normalize_text=True)
        try:
            for name, original in files.items():
                self.assertEqual((root / name).read_bytes(), original)
        finally:
            shutil.rmtree(root)

    def test_default_workspace_does_not_change_byte_inputs(self):
        root = build_workspace({"code.py": b"one\r\ntwo"})
        try:
            self.assertEqual((root / "code.py").read_bytes(), b"one\r\ntwo")
        finally:
            shutil.rmtree(root)

if __name__ == "__main__":
    unittest.main()
