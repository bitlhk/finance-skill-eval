import {it,expect} from 'vitest';
import {analyzeDependencies} from '../src/service/migration-dependencies.js';
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
