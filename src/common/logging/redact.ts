// Capability secrets that must never reach logs. The payment upload token rides
// in the URL path (GET/POST /payments/upload/:token); redact that segment so it
// does not land in pino-http request logs or error logs.
const UPLOAD_TOKEN_PATH = /(\/payments\/upload\/)[^/?#]+/g;

/** Replace the payment-upload token segment with [REDACTED], preserving the rest of the URL. */
export function redactSensitivePath<T extends string | undefined>(url: T): T {
  if (!url) return url;
  return url.replace(UPLOAD_TOKEN_PATH, '$1[REDACTED]') as T;
}

// Query-string keys whose VALUES must never be persisted (the SSE stream carries
// the admin JWT as ?token=, and future endpoints may carry similar credentials).
const SENSITIVE_QUERY_KEY = /token|secret|password|authorization|api[-_]?key/i;

/**
 * Shallow-redact credential-bearing values in a parsed query object before it is
 * logged. Non-objects pass through untouched; matching keys keep their presence
 * (useful for debugging) but lose their value.
 */
export function redactSensitiveQuery<T>(query: T): T {
  if (query === null || typeof query !== 'object' || Array.isArray(query)) return query;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    out[key] = SENSITIVE_QUERY_KEY.test(key) ? '[REDACTED]' : value;
  }
  return out as T;
}

// Correlation ids we accept from clients: UUID-like/safe token, bounded length.
// Anything else (huge strings, log-injection attempts) is replaced server-side.
const REQUEST_ID_SHAPE = /^[A-Za-z0-9._-]{8,64}$/;

/** Return the inbound X-Request-Id only when it is a safe correlation token. */
export function acceptableRequestId(raw: unknown): string | null {
  return typeof raw === 'string' && REQUEST_ID_SHAPE.test(raw) ? raw : null;
}
