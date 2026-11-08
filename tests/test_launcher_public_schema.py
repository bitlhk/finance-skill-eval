import json
import unittest
from pathlib import Path

from jsonschema import Draft202012Validator
from referencing import Registry, Resource


ROOT = Path(__file__).resolve().parents[1] / 'contracts' / 'runtime-launcher'


def load(name):
    return json.loads((ROOT / name).read_text(encoding='utf-8'))


class LauncherPublicSchemaTests(unittest.TestCase):
    def test_published_example_and_optional_capabilities(self):
        process = load('finance.runtime-process.v1.schema.json')
        evidence = load('finance.skill-eval.runtime-evidence.v1.schema.json')
        capabilities = load('finance.runtime-capabilities.v1.schema.json')
        example = load('examples/execution.evidence.json')
        features = load('examples/builder-capabilities.json')['features']
        Draft202012Validator.check_schema(process)
        Draft202012Validator(capabilities['properties']['features']).validate(features)
        registry = Registry().with_resource(process['$id'], Resource.from_contents(process))
        validator = Draft202012Validator(evidence, registry=registry)
        validator.validate(example)
        bad = {**example, 'metadata': {**example['metadata'], 'process': {
            'schemaVersion': 'finance.runtime-process.v1', 'status': 'PARTIAL', 'scopes': [], 'records': []}}}
        self.assertFalse(validator.is_valid(bad))
        bad['metadata']['process']['reason'] = 'collection unavailable'
        self.assertTrue(validator.is_valid(bad))
        # Historical execution evidence remains readable without the new field.
        legacy = {**example, 'metadata': {key: value for key, value in example['metadata'].items() if key != 'process'}}
        self.assertTrue(validator.is_valid(legacy))


if __name__ == '__main__':
    unittest.main()
