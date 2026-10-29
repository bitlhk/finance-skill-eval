import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { installRequestId, operationalError, requestLoggingOptions, serviceLoggerOptions, stderrExceptionType } from '../src/service/logging.js';

it('logs correlation and status without headers, query, body or upstream error content', async () => {
  let output = '';
  const stream = new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } });
  const app = Fastify({ ...requestLoggingOptions(), logger: { ...serviceLoggerOptions(), stream } });
  installRequestId(app);
  app.setErrorHandler((error, request, reply) => {
    request.log.error({ event: 'request_failed', err: error });
    return reply.code(500).send({ error: 'FAILED' });
  });
  app.post('/test', async () => { throw Object.assign(new Error('secret-error-body'), { cause: 'secret-cause', apiKey: 'secret-key' }); });
  const response = await app.inject({ method: 'POST', url: '/test?token=secret-query',
    headers: { authorization: 'Bearer secret-header', 'x-request-id': 'secret-client-id' }, payload: { password: 'secret-payload' } });
  await app.close();
  expect(response.statusCode).toBe(500);
  expect(response.headers['x-request-id']).toMatch(/^[a-f0-9-]{36}$/);
  for (const marker of ['secret-error-body','secret-cause','secret-key','secret-query','secret-header','secret-client-id','secret-payload'])
    expect(output).not.toContain(marker);
  const records = output.trim().split('\n').map(line => JSON.parse(line));
  expect(records.some(row => row.event === 'request_failed' && row.reqId === response.headers['x-request-id'])).toBe(true);
  expect(records.some(row => row.res?.statusCode === 500)).toBe(true);
});

it('keeps safe error categories while excluding arbitrary properties and stack', () => {
  expect(operationalError({ name: 'TypeError', code: 'ETIMEDOUT', statusCode: 503, stack: 'secret' }))
    .toMatchObject({ type: 'TypeError', code: 'ETIMEDOUT', statusCode: 503, stack: '' });
  expect(operationalError({ name: 'Bearer secret', code: 'http://secret' })).toMatchObject({ type: 'Error', code: undefined });
});

it('extracts only the final stderr exception category', () => {
  expect(stderrExceptionType('Traceback private path\nImportError: private key\nValueError: secret token')).toBe('ValueError');
  expect(stderrExceptionType('private content without an exception')).toBeUndefined();
  expect(stderrExceptionType('Exception: private')).toBe('Exception');
});
