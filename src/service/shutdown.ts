import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import { operationalError } from './logging.js';

export function registerStreamShutdown(app: FastifyInstance) {
  const streams = new Set<ServerResponse>();
  app.addHook('preClose', async () => {
    for (const stream of streams) stream.end();
    streams.clear();
  });
  return (stream: ServerResponse) => {
    streams.add(stream);
    stream.once('close', () => streams.delete(stream));
  };
}

export function installShutdown(app: FastifyInstance, timeoutMs = 45000) {
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    app.log.info({ event: 'service_stopping' });
    const deadline = setTimeout(() => {
      app.log.error({ event: 'service_shutdown_timeout', timeoutMs });
      process.exit(1);
    }, timeoutMs);
    deadline.unref();
    try {
      await app.close();
      app.log.info({ event: 'service_stopped' });
      process.exitCode = 0;
    } catch (error) {
      app.log.error({ event: 'service_shutdown_failed', err: operationalError(error) });
      process.exitCode = 1;
    } finally {
      clearTimeout(deadline);
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      process.off('message', message);
      if (process.connected) process.disconnect();
    }
  };
  const message = (value: unknown) => {
    if (value && typeof value === 'object' && 'type' in value && value.type === 'finance.shutdown') void stop();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('message', message);
  return stop;
}
