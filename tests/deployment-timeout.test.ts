import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

describe('synchronous migration inspection ingress',()=>{
  for(const file of ['deploy/finance-eval-origin.nginx.conf','deploy/finance-eval-demo.nginx.template']){
    it(`${file} lets the bounded agent return its own terminal result`,()=>{
      const text=readFileSync(file,'utf8');
      const reads=[...text.matchAll(/^\s*proxy_read_timeout\s+(\d+)s;/gmu)];
      expect(reads.length).toBeGreaterThan(0);
      // The runner has a 900-second total deadline; leave time to return failure.
      for(const match of reads)expect(Number(match[1])).toBeGreaterThanOrEqual(950);
      expect(text).not.toContain('proxy_read_timeout 0;');
    });
  }
});
