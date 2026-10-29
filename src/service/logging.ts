import { operationalError } from '../shared/operational-error.js';
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger, FastifyInstance, FastifyLoggerOptions } from 'fastify';
import type { PinoLoggerOptions } from 'fastify/types/logger.js';

export type OperationalLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;

export function stderrExceptionType(tail: string): string | undefined {
  return [...tail.matchAll(/(?:^|\n)((?:[A-Za-z][A-Za-z0-9_]{0,70})?(?:Error|Exception)):/g)].at(-1)?.[1];
}

// Error messages, causes and custom properties may contain upstream request
// bodies or credentials. Detailed evidence belongs in protected task storage.
export { operationalError } from '../shared/operational-error.js';

export function serviceLoggerOptions(): FastifyLoggerOptions & PinoLoggerOptions {
  const level = process.env.FINANCE_EVAL_LOG_LEVEL ?? 'info';
  if (!['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(level))
    throw new Error('FINANCE_EVAL_LOG_LEVEL_INVALID');
  return {
    level,
    hooks: {
      logMethod(input, method) {
        // Pino derives msg from err.message BEFORE applying serializers.
        // Sanitize at the call boundary too, including Fastify internal errors.
        const first = input[0];
        if (first instanceof Error) return method.call(this, { err: operationalError(first) }, 'operation failed');
        if (first && typeof first === 'object' && 'err' in first)
          input[0] = { ...first, err: operationalError(first.err) };
        method.apply(this, input);
      },
    },
    serializers: {
      req: (req: { method?: string; url?: string }) => ({ method: req.method, path: req.url?.split('?')[0] }),
      res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
      err: operationalError,
    },
    redact: ['req.headers', 'res.headers', 'headers', 'body', 'apiKey', 'accessToken', 'password', 'secrets'],
  };
}

export const requestLoggingOptions = () => ({ logger: serviceLoggerOptions(),
  requestIdHeader: false as const, genReqId: () => randomUUID() });

export function installRequestId(app: FastifyInstance) {
  app.addHook('onRequest', async (request, reply) => { reply.header('x-request-id', request.id); });
}

/** Used by subprocess supervisors; deliberately accepts only explicit metadata. */
export function operationalEvent(event: string, fields: Record<string, unknown> = {}) {
  process.stderr.write(JSON.stringify({ time: new Date().toISOString(), level: 'info',
    component: 'migration-process', event, ...fields }) + '\n');
}
