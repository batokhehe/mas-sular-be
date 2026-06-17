/**
 * TEMPORARY RabbitMQ connection diagnostics (credential-safe).
 *
 * Only protocol / host / port / virtual host are ever returned — username and
 * password are never read or logged. Error text is scrubbed of any embedded
 * credentials or usernames as a defensive second layer.
 *
 * Remove these call sites once the staging RabbitMQ connectivity is confirmed.
 */

/** Human-readable, credential-free description of an AMQP target. */
export function describeAmqpTarget(raw: string | undefined): string {
  if (!raw) return '(RABBITMQ_URL not set)';
  try {
    const u = new URL(raw);
    const protocol = u.protocol.replace(':', '');
    const port = u.port || (protocol === 'amqps' ? '5671 (default)' : '5672 (default)');
    const vhost = u.pathname && u.pathname !== '/' ? decodeURIComponent(u.pathname.slice(1)) : '/';
    return `protocol=${protocol} host=${u.hostname} port=${port} vhost=${vhost}`;
  } catch {
    return '(unparseable RABBITMQ_URL)';
  }
}

/** Strip any credentials/usernames that an error message might contain. */
function scrub(message: string): string {
  return message
    .replace(/\/\/[^@\s/]+@/g, '//***:***@') // user:pass@host inside any URL
    .replace(/\buser(name)?\b\s*[:=]?\s*['"][^'"]+['"]/gi, "user '***'");
}

/** Credential-free "code=… message=…" string from an AMQP/socket error. */
export function amqpErrorInfo(err: unknown): string {
  const e = err as { code?: string | number; errno?: string | number; message?: string };
  const code = e?.code ?? e?.errno;
  const message = scrub(err instanceof Error ? err.message : String(err));
  return code !== undefined ? `code=${code} message=${message}` : `message=${message}`;
}
