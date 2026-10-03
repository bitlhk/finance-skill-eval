import assert from 'node:assert/strict';

// Test fixtures are loopback-only. Preserve their declared routes, not an alias
// guessed from a Runtime family or whichever environment was registered first.
export function fixtureProfile(fixtures) {
  const routes = {};
  for (const family of ['openjiuwen', 'agentscope']) {
    const fixture = fixtures[family];
    assert.equal(fixture?.status, 'READY');
    const base = new URL(fixture.baseUrl);
    assert.equal(base.protocol, 'http:');
    assert.equal(base.hostname, '127.0.0.1');
    assert(!base.username && !base.password);
    const matches = Object.values(fixture.runtimes).filter(row => row.runtime?.type === family);
    assert.equal(matches.length, 1, 'A fixture must declare exactly one route per tested Runtime family');
    assert.equal(matches[0].runtime.version, family === 'openjiuwen' ? '0.1.15' : '2.0.3');
    const url = new URL(matches[0].path, base);
    assert.equal(url.origin, base.origin, 'A fixture route cannot change the source origin');
    assert(!url.username && !url.password && !url.search && !url.hash);
    routes[family] = url.toString();
  }
  return {routes, key: JSON.stringify(routes)};
}
