import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import type { MigrationTaskService } from '../../migration/tasks/application/task-service.js';

/** Activity is observational; cancellation remains owned by the task lifecycle. */
export function registerTaskActivityRoutes(app: FastifyInstance, tasks: MigrationTaskService) {
  const streams = new Set<ServerResponse>();
  app.addHook('preClose', async () => { for (const stream of streams) stream.end(); });
  const read = async (id: string) => { await tasks.get(id); return await tasks.activity?.get(id) ?? null; };
  app.get<{ Params: { id: string } }>('/api/migration-tasks/:id/activity', request => read(request.params.id));
  app.get<{ Params: { id: string } }>('/api/migration-tasks/:id/activity/events', async (request, reply) => {
    await tasks.get(request.params.id);
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    streams.add(reply.raw);
    let closed = false, reading = false, revision = '', lastSent = 0;
    const send = async () => {
      if (closed || reading || reply.raw.writableLength > 256000) return;
      reading = true;
      try {
        const state = await read(request.params.id);
        const next = state ? `${state.taskId}:${state.updatedAt}:${state.status}` : 'empty';
        if (!closed && next !== revision) {
          revision = next; lastSent = Date.now();
          reply.raw.write(`data: ${JSON.stringify(state)}\n\n`);
        } else if (!closed && Date.now() - lastSent > 5000) {
          lastSent = Date.now(); reply.raw.write(': heartbeat\n\n');
        }
      } catch { if (!closed) reply.raw.end(); }
      finally { reading = false; }
    };
    const timer = setInterval(() => void send(), 350); timer.unref();
    reply.raw.once('close', () => { closed = true; streams.delete(reply.raw); clearInterval(timer); });
    await send();
  });
}
