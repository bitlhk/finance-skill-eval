import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { registerStreamShutdown } from '../src/service/shutdown.js';

it('finishes a live SSE response before Fastify waits for open connections', async () => {
  const app = Fastify();
  const track = registerStreamShutdown(app);
  app.get('/events', async (_request, reply) => {
    reply.hijack();
    track(reply.raw);
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
    reply.raw.write('data: ready\n\n');
  });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const response = await fetch(url + '/events');
  const reader = response.body!.getReader();
  expect((await reader.read()).done).toBe(false);
  await app.close();
  expect((await reader.read()).done).toBe(true);
}, 10000);
