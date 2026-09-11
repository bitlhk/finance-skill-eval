import {describe,it,expect} from 'vitest';
import {fingerprint} from '../src/contracts.js';
import {canonicalNeutralArchive,nativeTransportAllowed} from '../src/service/neutral-archive.js';

function archive(overrides:Record<string,unknown>={}){
  const contract={method:'SKILL.md',mappingReview:{approved:true},capabilities:[{name:'query_account_balance',inputSchema:{type:'object'},outputSchema:{type:'object'}}],resources:[{path:'private.json',visibility:'TOOL_ONLY'}],...overrides};
  const files=Object.fromEntries(Object.entries({'SKILL.md':'method','private.json':'{}','source.py':'raise Exception("must not execute")','migration-generated/neutral-contract.json':JSON.stringify(contract)}).map(([n,c])=>[n,Buffer.from(c)]));
  const digest=fingerprint(Object.entries(files).sort(([a],[b])=>a.localeCompare(b)).map(([name,content])=>({name,content:content.toString('base64')})));
  return {files,digest};
}
describe('explicit native archive transport',()=>{
  it('retains code bytes as inert data and matches asset digest',()=>{const {files,digest}=archive();const result=canonicalNeutralArchive(files,digest);expect(fingerprint(JSON.parse(result))).toBe(digest);expect(JSON.parse(result)).toHaveLength(4);});
  it('rejects stale digests',()=>{const {files}=archive();expect(()=>canonicalNeutralArchive(files,'0'.repeat(64))).toThrow('integrity');});
  it.each([{mappingReview:{approved:false}},{capabilities:[{name:'get_data',inputSchema:null,outputSchema:null}]},{resources:[{path:'absent',visibility:'METHOD_CONTEXT'}]}])('rejects unresolved mapping %j',overrides=>{const {files,digest}=archive(overrides);expect(()=>canonicalNeutralArchive(files,digest)).toThrow();});
  it('requires exact server configured destination, not a frontend runtime label',()=>{expect(nativeTransportAllowed('http://127.0.0.1:56410/execute','')).toBe(false);expect(nativeTransportAllowed('http://127.0.0.1:56410/execute','http://127.0.0.1:56410/execute')).toBe(true);expect(nativeTransportAllowed('http://other/execute','http://127.0.0.1:56410/execute')).toBe(false);});
});
