"""v2: one or more inline Skills and optional resources, without a project archive."""
import base64
import copy
import re
from .bundle_runtime import files_digest, safe_path


def hydrate_skill_set(request, manager):
    if any(key in request for key in ('bundle', 'skill', 'variant')):
        raise ValueError('v2 accepts skills[] and optional assets; legacy fields are not allowed')
    skills = request.get('skills')
    if not isinstance(skills, list) or not 1 <= len(skills) <= 10:
        raise ValueError('v2 requires 1 to 10 Skills')
    files, members, ids, names, paths = {}, [], set(), set(), set()

    def decode(value):
        if not isinstance(value, str) or len(value) > 4 * ((manager.max_uncompressed_bytes + 2) // 3):
            raise ValueError('Skill resource exceeds Runtime limits')
        return base64.b64decode(value, validate=True)

    def put(path, raw):
        if not safe_path(path) or path.casefold() in paths:
            raise ValueError('Unsafe or duplicate Skill resource path')
        paths.add(path.casefold())
        files[path] = raw
        if len(files) > manager.max_files or sum(map(len, files.values())) > manager.max_uncompressed_bytes:
            raise ValueError('Skill resources exceed Runtime limits')

    for skill in skills:
        if not isinstance(skill, dict) or set(skill) - {'id', 'skillId', 'skillFile', 'version', 'artifactSha256', 'instructions', 'files'}:
            raise ValueError('Invalid Skill fields')
        member = {key: skill.get(key) for key in ('id', 'skillId', 'skillFile', 'version', 'artifactSha256')}
        entry, instructions = member['skillFile'], skill.get('instructions')
        if (not safe_path(entry) or not entry.endswith('SKILL.md') or entry.split('/')[-1] != 'SKILL.md'
                or not re.fullmatch(r'[a-z0-9-]+', member['id'] or '')
                or any(not isinstance(member[k], str) or not member[k] for k in ('skillId', 'version'))
                or not isinstance(instructions, str) or not instructions):
            raise ValueError('Invalid Skill identity or instructions')
        if member['id'] in ids or member['skillId'].casefold() in names:
            raise ValueError('Duplicate Skill identity')
        ids.add(member['id']); names.add(member['skillId'].casefold())
        own = {entry: instructions.encode('utf-8')}
        resources = skill.get('files', {})
        if not isinstance(resources, dict):
            raise ValueError('Skill files must be a base64 map')
        prefix = entry[:-len('SKILL.md')]
        for path, value in resources.items():
            if not safe_path(path) or not path.startswith(prefix) or path == entry:
                raise ValueError('Skill resource is outside its member directory')
            own[path] = decode(value)
        if files_digest(own) != member['artifactSha256']:
            raise ValueError('Skill member digest mismatch')
        for path, raw in own.items():
            put(path, raw)
        members.append(member)
    assets = request.get('assets', {})
    if not isinstance(assets, dict):
        raise ValueError('Assets must be a base64 file map')
    for path, value in assets.items():
        put(path, decode(value))
    entries = {m['skillFile'] for m in members}
    if entries != {p for p in files if p == 'SKILL.md' or p.endswith('/SKILL.md')}:
        raise ValueError('Every Skill entry must be declared')
    if any(a != b and (b.casefold().startswith(a.casefold() + '/') or
            (b.startswith(a[:-len('SKILL.md')]) and a in entries and b in entries)) for a in files for b in files):
        raise ValueError('Overlapping Skill or file paths')
    if files_digest(files) != request.get('contentDigest'):
        raise ValueError('Skill set content digest mismatch')
    text, binary = {}, {}
    for path, raw in files.items():
        try:
            text[path] = raw.decode('utf-8')
        except UnicodeDecodeError:
            binary[path] = base64.b64encode(raw).decode()
    entry = request.get('entryInstructionsFile')
    if entry and (not safe_path(entry) or entry not in text):
        raise ValueError('Entry instructions are missing')
    # SDK-internal mounted view. The public v2 request contains no bundle/archive.
    request['bundle'] = {'digest': request['contentDigest'], 'members': members, **({'entryInstructionsFile': entry} if entry else {})}
    request['skill'] = {'skillId': 'bundle', 'version': 'frozen', 'artifactSha256': request['contentDigest'],
                        'files': text, 'binaryFiles': binary, 'instructions': '', 'bundleMembers': copy.deepcopy(members)}
    request['variant'] = {'mode': 'skill_version', 'skillId': 'bundle', 'version': 'frozen', 'artifactSha256': request['contentDigest']}
