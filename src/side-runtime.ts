import type { RuntimeAdapter, RuntimeExecutionRequest } from './adapters.js';

/** A routing wrapper, not another execution engine. Both sides have their own lifecycle. */
export class SideRuntimeAdapter implements RuntimeAdapter {
  readonly adapterId: string;
  private started: RuntimeAdapter[] = [];
  constructor(private readonly sides: {left: RuntimeAdapter; right: RuntimeAdapter}) {
    this.adapterId = `side-runtime:${sides.left.adapterId}|${sides.right.adapterId}`;
  }
  async prepare(): Promise<void> {
    for (const adapter of [this.sides.left, this.sides.right]) {
      this.started.push(adapter);
      await adapter.prepare?.();
    }
  }
  async execute(request: RuntimeExecutionRequest) {
    request.signal?.throwIfAborted();
    return this.sides[request.side].execute(request);
  }
  async cleanup(): Promise<void> {
    const errors: unknown[] = [];
    for (const adapter of this.started.splice(0).reverse()) {
      try { await adapter.cleanup?.(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Runtime side cleanup failed');
  }
}
