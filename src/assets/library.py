"""Application access to verified Skill assets in the existing workspace."""
import asyncio
import base64
from copy import deepcopy
from .store import execute
from .runtime_skills import from_verified_files


class AssetLibrary:
    def __init__(self, configuration):
        self.configuration = configuration

    async def call(self, action, **fields):
        return await asyncio.to_thread(execute, {'root': self.configuration['dataDirectory'], 'action': action,
            'legacyOrderIndex': self.configuration['legacyOrderIndex'], **fields})

    async def resolve(self, variant, asset_id=None, *, strict=False):
        if variant['mode'] != 'skill_version':
            return None
        records = await self.call('list')
        matches = [asset for asset in records if asset['skillId'] == variant['skillId'] and asset['version'] == variant['version']
            and (not variant.get('artifactSha256') or asset['artifactSha256'] == variant['artifactSha256'])]
        asset = next((item for item in matches if item['assetId'] == asset_id), None)
        if not asset and not strict and len(matches) == 1:
            asset = matches[0]
        if not asset:
            raise ValueError('Skill artifact unavailable or ambiguous: ' + variant['skillId'] + '@' + variant['version'])
        files = await self.call('readArchive', id=asset['assetId'])
        entry = asset.get('skillFile', 'SKILL.md')
        instructions = base64.b64decode(files[entry], validate=True).decode('utf-8')
        texts = {}
        for name, content in files.items():
            try:
                texts[name] = base64.b64decode(content, validate=True).decode('utf-8')
            except UnicodeError:
                pass
        return {**deepcopy(asset), 'instructions': instructions, 'files': texts, 'archive': files,
                'skillSet': from_verified_files(asset, files)}
