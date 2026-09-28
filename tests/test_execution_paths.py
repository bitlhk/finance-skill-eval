from contextlib import ExitStack
from pathlib import Path
import tempfile
import unittest
from integrations.openjiuwen.execution_paths import execution_paths, read_execution_file


class ExecutionPathsTests(unittest.TestCase):
    def test_default_paths_are_separate_and_only_owned_paths_are_cleaned(self):
        with ExitStack() as stack:
            workspace, skill, digest = execution_paths(stack, {}, {'files':{'resource.txt':'skill'}})
            self.assertIsNone(digest)
            self.assertNotEqual(workspace, skill)
            self.assertNotIn(workspace, skill.parents)
            workspace.joinpath('report.txt').write_text('output')
            self.assertEqual(read_execution_file('report.txt', workspace, skill)[1], 'output')
            self.assertEqual(read_execution_file(str(skill / 'resource.txt'),workspace,skill)[1], 'skill')
        self.assertFalse(workspace.exists())
        self.assertFalse(skill.exists())

    def test_reading_outside_both_roots_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            external = Path(directory,'private.txt')
            external.write_text('private')
            workspace, skill, _ = execution_paths(stack, {}, None)
            with self.assertRaises(ValueError): read_execution_file(str(external), workspace, skill)
            with self.assertRaises(ValueError): read_execution_file('../private.txt', workspace, skill)

    def test_external_skill_must_match_loaded_artifact_and_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            skill = Path(directory,'installed')
            skill.mkdir()
            skill.joinpath('resource.txt').write_text('original')
            config = {'skillDirectories':{'digest':str(skill)}}
            with self.assertRaises(ValueError): execution_paths(stack,config,{'artifactSha256':'digest','files':{'resource.txt':'different'}})
            self.assertEqual(skill.joinpath('resource.txt').read_text(), 'original')

    def test_case_files_are_isolated_materialized_and_cleaned(self):
        with tempfile.TemporaryDirectory() as directory:
            shared = Path(directory, 'shared')
            shared.mkdir()
            shared.joinpath('existing.txt').write_text('must-not-be-visible')
            with ExitStack() as stack:
                workspace, _, digest = execution_paths(stack, {'workspaceDirectory': str(shared)}, None, [
                    {'path': 'fixtures/账户.json', 'content': '{"balance":1000}'},
                ])
                self.assertNotEqual(workspace, shared.resolve())
                self.assertFalse(workspace.joinpath('existing.txt').exists())
                self.assertEqual(workspace.joinpath('fixtures/账户.json').read_text(encoding='utf-8'), '{"balance":1000}')
                self.assertEqual(digest, 'a78efb585f6ada33ccc5409d97baa6a4134d2b1077e9ef167290937190072a2f')
            self.assertFalse(workspace.exists())
