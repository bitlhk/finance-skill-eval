"""Validate the published Launcher contracts without creating a second schema."""
import json
from functools import lru_cache
from pathlib import Path
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parents[2] / 'contracts' / 'runtime-launcher'


@lru_cache(maxsize=1)
def schemas():
    documents = {path.name: json.loads(path.read_text(encoding='utf-8')) for path in ROOT.glob('*.schema.json')}
    registry = Registry().with_resources((value['$id'], Resource.from_contents(value)) for value in documents.values() if '$id' in value)
    return {name: Draft202012Validator(value, registry=registry, format_checker=FormatChecker()) for name, value in documents.items()}


def validate(name, value, property=None):
    # ValidationError's text can include sensitive instance values. Only expose
    # the contract and field path, never a provider/tool payload.
    validator = schemas()[name + '.schema.json']
    if property is not None:
        validator = validator.evolve(schema=validator.schema['properties'][property])
    error = next(validator.iter_errors(value), None)
    if error:
        raise ValueError('Invalid ' + name + ' at /' + '/'.join(map(str, error.absolute_path)))
    return value


def validate_skill_set(value):
    parent = schemas()['finance.runtime-instance.v1.schema.json']
    fields = ('skills', 'executionMode', 'assets', 'contentDigest', 'entryInstructionsFile')
    schema = {'type': 'object', 'additionalProperties': False, 'required': ['skills', 'contentDigest'],
              'properties': {key: parent.schema['properties'][key] for key in fields},
              '$defs': parent.schema.get('$defs', {}),
              'allOf': parent.schema.get('allOf', [])}
    error = next(parent.evolve(schema=schema).iter_errors(value), None)
    if error:
        raise ValueError('Invalid runtime Skill set at /' + '/'.join(map(str, error.absolute_path)))
    return value
