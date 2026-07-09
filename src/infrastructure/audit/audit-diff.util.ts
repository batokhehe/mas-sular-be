/**
 * PURE diff/snapshot helpers for the Audit Trail. No I/O — unit-testable alone.
 */

export interface DiffEntry {
  field: string;
  before: unknown;
  after: unknown;
}

// Volatile/technical fields never worth auditing as changes.
const IGNORED_KEYS = new Set(['updatedAt', 'createdAt', 'lastLogin', 'deletedAt', 'expiresAt', 'lockedUntil', 'nextAttemptAt']);
const isIgnored = (key: string): boolean => IGNORED_KEYS.has(key) || /(At|Timestamp)$/.test(key);

// Secrets are stripped from snapshots BEFORE persisting (never stored).
const SENSITIVE_KEYS = new Set(['password', 'passwordHash', 'token', 'tokenHash', 'secret', 'apiKey', 'authorization', 'refreshToken', 'accessToken', 'webhookPayload']);

/** Deep-copy a snapshot with secrets removed and keys sorted (stable pretty JSON). */
export function sanitizeSnapshot(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => sanitizeSnapshot(v));
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (SENSITIVE_KEYS.has(key)) continue;
    out[key] = sanitizeSnapshot((value as Record<string, unknown>)[key]);
  }
  return out;
}

const normalized = (v: unknown): string => JSON.stringify(v instanceof Date ? v.toISOString() : v ?? null);

/**
 * Generic shallow diff of two object snapshots: ignored/timestamp keys skipped,
 * fields sorted, nested values compared structurally. Returns [] when either side
 * is missing (CREATE/DELETE show full snapshots instead of a field diff).
 */
export function computeDiff(before: unknown, after: unknown): DiffEntry[] {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return [];
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => !isIgnored(k) && !SENSITIVE_KEYS.has(k)).sort();
  const diff: DiffEntry[] = [];
  for (const field of keys) {
    if (normalized(b[field]) !== normalized(a[field])) {
      diff.push({ field, before: b[field] ?? null, after: a[field] ?? null });
    }
  }
  return diff;
}

/** Stable, human-readable JSON for storage/display. */
export function prettyJson(value: unknown): string {
  return JSON.stringify(sanitizeSnapshot(value), null, 2);
}

// Common display-name fields across our entities, in preference order.
const NAME_FIELDS = ['name', 'title', 'orderNumber', 'code', 'email', 'bankName', 'template', 'label'];

/** Best-effort display name for an entity snapshot (null when nothing matches). */
export function deriveEntityName(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const record = snapshot as Record<string, unknown>;
  for (const field of NAME_FIELDS) {
    const v = record[field];
    if (typeof v === 'string' && v.length > 0) return v.slice(0, 255);
  }
  return null;
}
