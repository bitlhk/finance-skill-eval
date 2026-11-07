"""Read-only access to the frozen evidence supplied to a role invocation."""
import hashlib
import json
from evaluation.checks import read_pointer


def evidence_index(resources):
    items = enumerate(resources) if isinstance(resources, list) else resources.items() if isinstance(resources, dict) else []
    return [{'path': '/' + str(key).replace('~', '~0').replace('/', '~1'),
             'type': 'array' if isinstance(value, list) else 'object' if isinstance(value, dict) else type(value).__name__,
             **({'items': len(value)} if isinstance(value, list) else {})} for key, value in items]


def query_evidence(resources, path, operation='read', offset=0, limit=6000):
    if (not isinstance(path, str) or len(path) > 500 or operation not in ('read', 'list')
            or type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 12000):
        raise ValueError('Invalid evidence query')
    missing = object()
    value = read_pointer(resources, path, missing)
    if value is missing:
        return {'available': False, 'path': path}
    if operation == 'list':
        items = list(enumerate(value)) if isinstance(value, list) else list(value.items()) if isinstance(value, dict) else []
        limit = min(limit, 64)
        return {'available': True, 'path': path, 'entries': [
            {'path': path + '/' + str(key).replace('~', '~0').replace('/', '~1'),
             'label': str(item.get('path', key)) if isinstance(item, dict) else str(key),
             'type': 'array' if isinstance(item, list) else 'object' if isinstance(item, (dict, type(None))) else
                     'boolean' if isinstance(item, bool) else 'number' if isinstance(item, (float, int)) else 'string'}
            for key, item in items[offset:offset + limit]], 'totalItems': len(items),
            'nextOffset': offset + limit if offset + limit < len(items) else None}
    text = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    encoded = text.encode('utf-16-le')
    size = len(encoded) // 2
    return {'available': True, 'path': path, 'digest': hashlib.sha256(text.encode()).hexdigest(),
            'content': encoded[offset * 2:(offset + limit) * 2].decode('utf-16-le', errors='surrogatepass'),
            'totalCharacters': size, 'nextOffset': offset + limit if offset + limit < size else None}
