import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import { OpenAiCompatibleModelAdapter } from '../src/openai-compatible-model.js';

afterEach(() => vi.unstubAllEnvs());

it('routes model HTTP through the configured proxy and honors NO_PROXY', async () => {
  const sockets = new Set<Socket>();
  const origin = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: 'transport checked' } }] }));
  });
  const proxy = createServer();
  let tunnels = 0;
  for (const server of [origin, proxy]) server.on('connection', socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
  const port = (origin.address() as { port: number }).port;
  proxy.on('connect', (_request, downstream, head) => {
    tunnels++;
    const upstream = connect(port, '127.0.0.1', () => {
      downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      downstream.pipe(upstream); upstream.pipe(downstream);
    });
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => downstream.destroy());
    downstream.on('error', () => upstream.destroy());
    downstream.on('close', () => upstream.destroy());
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) vi.stubEnv(key, proxyUrl);
  for (const key of ['NO_PROXY', 'no_proxy']) vi.stubEnv(key, 'localhost,127.0.0.1');
  try {
    for (const host of ['model.invalid', '127.0.0.1']) {
      const adapter = new OpenAiCompatibleModelAdapter({ apiKey: 'transport-test', baseUrl: `http://${host}:${port}/v1`, timeoutMs: 5000 });
      const result = await adapter.complete({ requestId: 'proxy-check', model: { providerId: 'test', modelId: 'test', parameters: {} }, messages: [] });
      expect(result.content).toBe('transport checked');
      expect(tunnels).toBe(1);
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all([origin, proxy].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  }
});
