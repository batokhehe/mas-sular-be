// Capability secrets that must never reach logs. The payment upload token rides
// in the URL path (GET/POST /payments/upload/:token); redact that segment so it
// does not land in pino-http request logs or error logs.
const UPLOAD_TOKEN_PATH = /(\/payments\/upload\/)[^/?#]+/g;

/** Replace the payment-upload token segment with [REDACTED], preserving the rest of the URL. */
export function redactSensitivePath<T extends string | undefined>(url: T): T {
  if (!url) return url;
  return url.replace(UPLOAD_TOKEN_PATH, '$1[REDACTED]') as T;
}
