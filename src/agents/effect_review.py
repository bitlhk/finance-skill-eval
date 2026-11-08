"""Independent effect-review contract and evidence gates, shared by all callers."""
from copy import deepcopy
from jsonschema import Draft202012Validator
from improvement.policy import review_input_gate, validate_review_references


TEXT = {'type': 'string', 'minLength': 1}
STRINGS = {'type': 'array', 'items': {'type': 'string'}}


def obj(properties, required=()):
    return {'type': 'object', 'additionalProperties': False, 'properties': properties, 'required': list(required)}


COUNTS = obj({**{key: {'type': 'integer', 'minimum': 0} for key in ('total', 'passed', 'failed', 'incomplete')},
              'passRate': {'type': ['number', 'null'], 'minimum': 0, 'maximum': 1}},
             ('total', 'passed', 'failed', 'incomplete', 'passRate'))
INPUT = obj({'goal': TEXT, 'assessmentMode': {'enum': ['COMPARISON', 'GOAL']}, 'baselineDigest': TEXT, 'candidateDigest': TEXT, 'incumbentDigest': TEXT,
    'protectedCaseIds': STRINGS, 'targetPassRate': {'type': 'number', 'minimum': 0, 'maximum': 1},
    'remainingRounds': {'type': 'integer', 'minimum': 0},
    'evaluationSummary': obj({'scope': {'const': 'SELECTED_DEVELOPMENT_SET'},
        'baseline': COUNTS, 'candidate': COUNTS, 'incumbent': COUNTS}, ('scope', 'candidate')),
    'contextChanges': {'type': 'array', 'items': obj({'beforeProtocolDigest': {'type': 'string'},
        'afterProtocolDigest': {'type': 'string'}, 'criteriaDigest': {'type': 'string'}, 'reference': TEXT, 'reason': TEXT},
        ('beforeProtocolDigest', 'afterProtocolDigest', 'criteriaDigest', 'reference', 'reason'))},
    'basicValidation': obj({'baseline': {}, 'candidate': {}, 'incumbent': {}}),
    'changes': {'type': 'array', 'items': obj({key: {'type': 'string'} for key in ('path', 'reason', 'before', 'after')}, ('path', 'reason'))},
    'evidence': {'type': 'array', 'items': obj({'evidenceId': TEXT, 'evaluationDigest': TEXT,
        'completed': {'type': 'boolean'}, 'comparable': {'type': 'boolean'}, 'summary': TEXT,
        'baseline': {}, 'candidate': {}, 'incumbent': {}}, ('evidenceId', 'evaluationDigest', 'completed', 'summary'))}},
    ('goal', 'candidateDigest', 'changes', 'evidence'))
INPUT['allOf'] = [{'if': {'properties': {'assessmentMode': {'const': 'GOAL'}}, 'required': ['assessmentMode']},
                  'then': {'not': {'anyOf': [{'required': ['baselineDigest']}, {'required': ['incumbentDigest']}]}},
                  'else': {'required': ['baselineDigest']}}]
OUTPUT = {'oneOf': [obj({'status': {'const': 'ABSTAINED'}, 'reason': TEXT}, ('status', 'reason')),
    obj({'status': {'const': 'PRODUCED'}, 'review': obj({
        'recommendation': {'enum': ['KEEP_CANDIDATE', 'CONTINUE_CANDIDATE', 'KEEP_BASELINE', 'INCONCLUSIVE']},
        'reason': TEXT, 'improvements': STRINGS, 'regressions': STRINGS,
        'evidenceIds': {**STRINGS, 'minItems': 1}, 'tradeoff': TEXT, 'nextFocus': {'type': 'array', 'items': TEXT}},
        ('recommendation', 'reason', 'improvements', 'regressions', 'evidenceIds'))}, ('status', 'review'))]}


def validated(schema, value):
    error = next(Draft202012Validator(schema).iter_errors(value), None)
    if error:
        raise ValueError('Invalid effect review at /' + '/'.join(map(str, error.absolute_path)))
    return value


def gate(value):
    return review_input_gate(validated(INPUT, value)['evidence'], value.get('assessmentMode', 'COMPARISON'))


def assess(value, result):
    validated(INPUT, value)
    result = deepcopy(result)
    if isinstance(result, dict) and isinstance(result.get('review'), dict):
        status = result.get('status')
        if status is None or isinstance(status, str) and status.upper() in (
                'PRODUCED', 'COMPLETE', 'COMPLETED', 'FINISHED', 'DONE', 'REVIEWED', 'SUCCESS', 'SUCCEEDED', 'OK'):
            result['status'] = 'PRODUCED'
    if isinstance(result, dict):
        for field in ('reason',):
            if result.get('status') == 'ABSTAINED' and isinstance(result.get(field), str):
                result[field] = result[field].strip()
        review = result.get('review')
        if isinstance(review, dict):
            if isinstance(review.get('tradeoff'), str):
                review['tradeoff'] = review['tradeoff'].strip()
            if isinstance(review.get('nextFocus'), list):
                review['nextFocus'] = [item.strip() if isinstance(item, str) else item for item in review['nextFocus']]
    validated(OUTPUT, result)
    if value.get('assessmentMode') == 'GOAL' and result['status'] == 'PRODUCED':
        review = result['review']
        if review['improvements'] or review['regressions'] or review['recommendation'] == 'KEEP_BASELINE':
            raise ValueError('目标审查不能声称未经对比的提升或回退')
    validate_review_references(value['evidence'], result)
    return result
