"""Published data contracts; business policies stay in their owning modules."""
from functools import lru_cache
import json
from copy import deepcopy
from pathlib import Path
from jsonschema import Draft7Validator, FormatChecker


@lru_cache(maxsize=None)
def validator(name):
    if name not in ('environment_record', 'environment_create', 'launcher_delivery', 'native_tool_catalog',
                    'build_requirements', 'build_result', 'eval_case', 'eval_pack', 'judge_profile', 'run_configuration',
                    'prepare_skill', 'manual_preparation', 'migration_suite', 'create_task', 'task_configuration',
                    'task_operation', 'task_analysis', 'task_delivery', 'delivery_review', 'project_execution', 'optimization_goal',
                    'telemetry', 'case_state', 'task_build_input', 'rescore_request', 'judge_result', 'improvement_judgement',
                    'review_source', 'review_import', 'project_preparation', 'runtime_tool_configuration', 'execution_evidence'):
        raise ValueError('Unknown application contract')
    path = Path(__file__).resolve().parents[2] / 'contracts/platform/schemas' / (name + '.json')
    return Draft7Validator(json.loads(path.read_text(encoding='utf-8')), format_checker=FormatChecker())


def validate(name, value):
    error = next(validator(name).iter_errors(value), None)
    if error:
        raise ValueError('Invalid ' + name + ' at /' + '/'.join(map(str, error.absolute_path)))
    return value


def parse(name, value):
    """Apply the published defaults without duplicating the authoring schemas."""
    contract = validator(name)
    root = contract.schema
    def apply(schema, item):
        if '$ref' in schema:
            reference = schema['$ref']
            if not reference.startswith('#/'):
                raise ValueError('Application contract must use local references')
            target = root
            for part in reference[2:].split('/'):
                part = part.replace('~1', '/').replace('~0', '~')
                target = target[int(part)] if isinstance(target, list) else target[part]
            return apply(target, item)
        for kind in ('anyOf', 'oneOf'):
            for branch in schema.get(kind, []):
                if contract.evolve(schema=branch).is_valid(item):
                    return apply(branch, item)
        for branch in schema.get('allOf', []):
            item = apply(branch, item)
        if isinstance(item, dict):
            for key, field in schema.get('properties', {}).items():
                if key not in item and 'default' in field:
                    item[key] = deepcopy(field['default'])
                if key in item:
                    item[key] = apply(field, item[key])
            extra = schema.get('additionalProperties')
            if isinstance(extra, dict):
                for key in set(item) - set(schema.get('properties', {})):
                    item[key] = apply(extra, item[key])
        elif isinstance(item, list) and isinstance(schema.get('items'), dict):
            item = [apply(schema['items'], child) for child in item]
        return item
    return validate(name, apply(root, deepcopy(value)))
