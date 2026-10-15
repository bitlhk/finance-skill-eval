import {it,expect} from 'vitest';
import {analyzeDependencies} from '../src/migration/infrastructure/migration-dependencies.js';
import {inspectionFixture,toolFixture} from './analysis-fixture.js';
const files={'scripts/query.py':'def query():\n    return lookup_value()\n'};
const inspection=inspectionFixture([toolFixture({name:'query',sourcePaths:['scripts/query.py']})]);
function payload(condition:unknown,include=true){return {dependencyAnalysis:{dependencies:[],chains:[{toolName:'query',nodes:[{id:'entry',title:'Entry',detail:'Query entry',evidence:[{path:'scripts/query.py',snippet:'def query():'}]},{id:'lookup',title:'Lookup',detail:'Query value',evidence:[{path:'scripts/query.py',snippet:'return lookup_value()'}]}],edges:[{from:'entry',to:'lookup',...(include?{condition}:{})}]}]}}}
it('accepts null and omitted conditions and persists both without a condition property',()=>{
 for(const p of [payload(null),payload(undefined,false)]){const r=analyzeDependencies(p,inspection,files,[],0,'source');expect(r.status).toBe('COMPLETE');expect(r.chains[0]!.edges).toEqual([{from:'entry',to:'lookup'}]);expect(Object.hasOwn(r.chains[0]!.edges[0]!, 'condition')).toBe(false)}
});
it('retains conditional text and still checks edge endpoints',()=>{
 const p=payload('request exists'),r=analyzeDependencies(p,inspection,files,[],0,'source');expect(r.status).toBe('COMPLETE');expect(r.chains[0]!.edges[0]!.condition).toBe('request exists');
 p.dependencyAnalysis.chains[0]!.edges[0]!.to='missing';const invalid=analyzeDependencies(p,inspection,files,[],0,'source');expect(invalid.status).toBe('PARTIAL');expect(invalid.chains[0]!.edges).toEqual([]);
});
it('continues to reject conditions with a genuinely invalid type',()=>{
 for(const value of [42,false,{},[]])expect(analyzeDependencies(payload(value),inspection,files,[],0,'source').status).toBe('UNAVAILABLE');
});
it('merges equivalent tool entrypoint graphs without inventing transitions or duplicating shared nodes',()=>{
 const p=payload(null),alternative=structuredClone(p.dependencyAnalysis.chains[0]!);
 alternative.nodes[0]!.id='cli-entry';alternative.edges[0]!.from='cli-entry';
 p.dependencyAnalysis.chains.push(alternative,structuredClone(alternative));
 const result=analyzeDependencies(p,inspection,files,[],0,'source');
 expect(result.status).toBe('COMPLETE');expect(result.rejectedClaims).toBe(0);expect(result.chains).toHaveLength(1);
 expect(result.chains[0]!.nodes.map(n=>n.id)).toEqual(['entry','lookup','cli-entry']);
 expect(result.chains[0]!.edges).toEqual([{from:'entry',to:'lookup'},{from:'cli-entry',to:'lookup'}]);
});
it('still rejects conflicting shared nodes and invalid edges across entrypoint graphs',()=>{
 const p=payload(null),conflict=structuredClone(p.dependencyAnalysis.chains[0]!);
 conflict.nodes[1]!.detail='Conflicting behavior';p.dependencyAnalysis.chains.push(conflict);
 const rejected=analyzeDependencies(p,inspection,files,[],0,'source');
 expect(rejected.status).toBe('PARTIAL');expect(rejected.chains[0]!.nodes[1]!.detail).toBe('Query value');
 conflict.nodes[1]!.detail='Query value';conflict.edges[0]!.to='missing';
 expect(analyzeDependencies(p,inspection,files,[],0,'source').status).toBe('PARTIAL');
});
