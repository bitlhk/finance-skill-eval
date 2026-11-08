"""Shared task timestamps and JSON fingerprints, compatible with existing records."""
import hashlib
import json
import math
import rfc8785
from datetime import datetime, timezone


def now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def workspace_digest(files):
    digest = hashlib.sha256()
    for file in sorted(files, key=lambda file: file['path'].encode('utf-16-be')):
        digest.update((file['path'] + '\0' + file['content'] + '\0').encode('utf-8'))
    return digest.hexdigest()


def fingerprint(value):
    def normalized(item):
        if isinstance(item, dict):
            return {key: normalized(item[key]) for key in sorted(item, key=lambda key: key.encode('utf-16-be', errors='surrogatepass'))}
        if isinstance(item, list):
            return [normalized(part) for part in item]
        if isinstance(item, float) and math.isfinite(item) and item.is_integer():
            return int(item)
        return item
    text = json.dumps(normalized(value), ensure_ascii=False, separators=(',', ':'), allow_nan=False)
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def canonical_fingerprint(value):
    """RFC 8785 identity retained for historical human evidence annotations."""
    return hashlib.sha256(rfc8785.dumps(value)).hexdigest()
