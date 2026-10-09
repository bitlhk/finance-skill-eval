import assert from 'node:assert/strict';
import test from 'node:test';
import {fixtureProfile, fixtureExecution} from './native-fixture-profile.mjs';

function fixtures(port = 18111) {
  const fixture = {status: 'READY', baseUrl: `http://127.0.0.1:${port}/`, runtimes: {
    oj: {path: 'oj/', runtime: {type: 'openjiuwen', version: '0.1.15'}},
    as: {path: 'as/', runtime: {type: 'agentscope', version: '2.0.3'}}}};
  return {openjiuwen: fixture, agentscope: fixture};
}
test('live page execution is explicit and consistent with both fixture declarations', () => {
  assert.equal(fixtureExecution(fixtures()), 'NOT_RUN');
  assert.throws(() => fixtureExecution(fixtures(), 'LIVE'));
  const live=fixtures();
  live.openjiuwen.realModel='LIVE';
  assert.equal(fixtureExecution(live, 'LIVE'), 'LIVE');
  assert.throws(() => fixtureExecution(live));
  assert.throws(() => fixtureExecution(live, 'AUTO'));
  const mixed={openjiuwen:live.openjiuwen,agentscope:fixtures().agentscope};
  assert.throws(() => fixtureExecution(mixed, 'LIVE'));
});
test('preserves the actual declared paths and separates source profiles', () => {
  const first = fixtureProfile(fixtures());
  assert.equal(first.routes.openjiuwen, 'http://127.0.0.1:18111/oj/');
  assert.equal(first.routes.agentscope, 'http://127.0.0.1:18111/as/');
  assert.notEqual(first.key, fixtureProfile(fixtures(18112)).key);
  assert.equal(first.key, fixtureProfile(fixtures()).key);
});
test('rejects missing and ambiguous runtime identities', () => {
  const missing = fixtures(); delete missing.openjiuwen.runtimes.oj;
  assert.throws(() => fixtureProfile(missing));
  const duplicate = fixtures(); duplicate.openjiuwen.runtimes.other = duplicate.openjiuwen.runtimes.oj;
  assert.throws(() => fixtureProfile(duplicate));
  const wrong = fixtures(); wrong.openjiuwen.runtimes.oj.runtime.version = 'unknown';
  assert.throws(() => fixtureProfile(wrong));
});
test('never sends fixture credentials to a substituted origin', () => {
  for (const route of ['https://example.com/oj/', '//example.com/oj/', 'http://u:p@127.0.0.1:18111/oj/']) {
    const value = fixtures(); value.openjiuwen.runtimes.oj.path = route;
    assert.throws(() => fixtureProfile(value));
  }
});
