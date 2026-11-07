import base64
from tempfile import TemporaryDirectory
import unittest
from uuid import uuid4
from improvement.source import source_evidence, version_entry
from improvement.engineering import adjust


def encoded(value):
    return base64.b64encode(value if isinstance(value, bytes) else value.encode()).decode()


class EngineeringTests(unittest.IsolatedAsyncioTestCase):
    def test_code_evidence_preserves_binary_and_sensitive_files_outside_model_input(self):
        archive = {'SKILL.md': encoded('Read scripts/check.py'), 'scripts/check.py': encoded('print(1)'),
            'shared/client.js': encoded('export const query = () => 1;'), 'data.bin': encoded(b'\0\xff'), '.env': encoded('TOKEN=private-value-123')}
        result = source_evidence(archive)
        self.assertEqual([file['path'] for file in result['files']], ['SKILL.md', 'scripts/check.py', 'shared/client.js'])
        self.assertIn({'path': 'data.bin', 'reason': 'binary'}, result['omitted'])
        self.assertIn({'path': '.env', 'reason': 'sensitive'}, result['omitted'])
        self.assertNotIn('private-value', str(result))

    async def test_same_main_agent_edits_skill_and_tool_preserving_protected_assets(self):
        archive = {'SKILL.md': encoded('---\nname: example\ndescription: test\n---\nRead scripts/tool.py.'),
            'scripts/tool.py': encoded('print(1)'), 'data.bin': encoded(b'\0\xff'), '.env': encoded('TOKEN=private-secret-123')}
        async def agent(inputs, correlation, **options):
            self.assertEqual(inputs['mode'], 'CHAT')
            self.assertNotIn('.env', inputs['base']['files'])
            self.assertEqual(inputs['feedback']['diagnosis']['hypothesis']['issue'], 'Wrong output')
            self.assertEqual(inputs['feedback']['deliveryTools']['services'][0]['start'], ['python', 'scripts/tool.py'])
            self.assertIn('单次文件调整', inputs['clarification'])
            return {'status': 'PRODUCED', 'message': 'Repaired Skill and tool', 'files': {**inputs['base']['files'],
                'scripts/tool.py': encoded('print(2)'), 'SKILL.md': encoded('---\nname: example\ndescription: test\n---\nRead corrected tool.')},
                'deliveryTools': {'services': [{'start': ['python', 'scripts/tool.py', '--stdio']}], 'tools': []},
                'deliveryReviews': [{'decision': 'RECOMMEND', 'summary': 'Static observations only'}]}
        with TemporaryDirectory() as root:
            result = await adjust(root, 'bundle-' + str(uuid4()), archive, archive, 'Correct output', [],
                diagnosis={'hypothesis': {'issue': 'Wrong output'}}, agent=agent,
                delivery_tools={'services': [{'start': ['python', 'scripts/tool.py']}], 'tools': []})
        self.assertEqual(result['files']['.env'], archive['.env'])
        self.assertEqual(result['files']['data.bin'], archive['data.bin'])
        self.assertEqual(set(result['changed']), {'scripts/tool.py', 'SKILL.md'})
        self.assertEqual(result['deliveryTools']['services'][0]['start'], ['python', 'scripts/tool.py', '--stdio'])
        self.assertNotIn('deliveryReviews', result)  # Independent effect Review stays with the outer loop.

    async def test_binary_and_hidden_changes_are_rejected(self):
        archive = {'SKILL.md': encoded('Skill'), 'data.bin': encoded(b'\0\xff'), '.env': encoded('TOKEN=private-secret-123')}
        for name, value in [('data.bin', encoded('changed')), ('.env', encoded('new'))]:
            async def agent(inputs, correlation, **options):
                return {'status': 'PRODUCED', 'message': 'Changed', 'files': {**inputs['base']['files'], name: value}}
            with TemporaryDirectory() as root, self.assertRaises(ValueError):
                await adjust(root, 'bundle-' + str(uuid4()), archive, archive, 'goal', [], agent=agent)

    def test_version_preserves_crlf_and_instruction_body(self):
        text = '---\r\nname: example\r\nversion: old\r\n---\r\nInstructions\r\n'
        result = version_entry({'SKILL.md': encoded(text)}, 'SKILL.md', 'candidate.1')
        value = base64.b64decode(result['SKILL.md']).decode()
        self.assertIn('version: candidate.1\r\n', value)
        self.assertTrue(value.endswith('---\r\nInstructions\r\n'))
