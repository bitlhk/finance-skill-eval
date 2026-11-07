"""Assemble existing assets for Launcher/Builder using shared archive and digest code."""
import base64
import hashlib
from copy import deepcopy

from .snapshot import decode_content, files_digest, validate_path
from .store import archive_entries
from runtime.contracts import validate_skill_set


def from_files(source):
    files, assets = source['files'], deepcopy(source['files'])
    skills = []
    for member in source['members']:
        entry = member['skillFile']
        validate_path(entry)
        prefix = entry[:-len('SKILL.md')]
        own = {}
        for name, content in files.items():
            validate_path(name)
            if name.startswith(prefix):
                assets.pop(name, None)
                if name != entry:
                    own[name] = content
        if entry not in files:
            raise ValueError('Skill entry is missing')
        skills.append({**member, 'instructions': decode_content(files[entry]).decode('utf-8'),
                       **({'files': own} if own else {})})
    result = {'skills': skills, 'contentDigest': source['digest']}
    if assets:
        result['assets'] = assets
    if source.get('entryInstructionsFile'):
        result['entryInstructionsFile'] = source['entryInstructionsFile']
    return validate_skill_set(result)


def from_asset(asset):
    entry = asset.get('skillFile') or 'SKILL.md'
    if asset.get('archiveBase64'):
        encoded = asset['archiveBase64']
        if hashlib.sha256(decode_content(encoded)).hexdigest() != asset.get('archiveSha256'):
            raise ValueError('Asset archive digest mismatch')
        files = {name: base64.b64encode(content).decode('ascii') for name, content in archive_entries(encoded).items()}
    else:
        files = {name: base64.b64encode(value.encode('utf-8')).decode('ascii')
                 for name, value in {**asset.get('files', {}), entry: asset['instructions']}.items()}
    return from_verified_files(asset, files)


def from_verified_files(asset, files):
    entry = asset.get('skillFile') or 'SKILL.md'
    # The selected-asset adapter historically sorted names by UTF-16 code units.
    # Existing task snapshots retain their original UTF-8 sort convention.
    digest = lambda selected: files_digest(selected, sort_key=lambda name: name.encode('utf-16-be'))
    own = {name: content for name, content in files.items() if name.startswith(entry[:-len('SKILL.md')])}
    return from_files({'digest': digest(files), 'files': files, 'members': [{'id': 'selected-skill',
        'skillId': asset['skillId'], 'version': asset['version'], 'skillFile': entry, 'artifactSha256': digest(own)}]})


def stats(skill_set):
    files = dict(skill_set.get('assets', {}))
    for skill in skill_set['skills']:
        files.update(skill.get('files', {}))
        files[skill['skillFile']] = base64.b64encode(skill['instructions'].encode('utf-8')).decode('ascii')
    return {'count': len(files), 'bytes': sum(len(decode_content(content)) for content in files.values())}


def execute(request):
    action = request['action']
    if action == 'from_asset':
        return from_asset(request['asset'])
    if action == 'from_files':
        return from_files(request['input'])
    if action == 'stats':
        return stats(validate_skill_set(request['skillSet']))
    raise ValueError('Unknown runtime asset operation')
