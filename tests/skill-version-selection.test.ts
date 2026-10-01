import {describe,it,expect} from 'vitest';
import {selectedVersion,versionSelectionKey} from '../web/src/skill-version-selection.js';

describe('immutable Skill selection',()=>{
  const first={version:'1.0',artifactSha256:'a'.repeat(64),assetId:'first'};
  const second={version:'1.0',artifactSha256:'b'.repeat(64),assetId:'second'};
  it('keeps same-version different-content assets distinct',()=>{
    expect(versionSelectionKey(first)).not.toBe(versionSelectionKey(second));
    expect(selectedVersion(versionSelectionKey(second),[first,second])).toEqual(second);
  });
  it('does not guess ambiguous legacy versions, even with a digestless option',()=>{
    expect(selectedVersion('version:1.0',[first,second])).toBeUndefined();
    expect(selectedVersion('version:1.0',[{version:'1.0',artifactSha256:null},first])).toBeUndefined();
  });
  it('supports unambiguous old selections but never falls back from an unknown digest',()=>{
    expect(selectedVersion('version:1.0',[first])).toEqual(first);
    expect(selectedVersion(versionSelectionKey(second),[first])).toBeUndefined();
  });
});
