import { AsyncLocalStorage } from 'async_hooks';

/**
 * Per-request context propagated via AsyncLocalStorage so every log emitted while
 * handling one HTTP request shares the same `requestId` (correlation). Populated by
 * RequestLoggingMiddleware; read by LogService and the exception filter.
 */
export interface RequestContext {
  requestId: string;
  ip?: string | null;
  method?: string | null;
  path?: string | null;
  userId?: string | null;
  adminId?: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
