/**
 * PAXELBOX-61E: pure transformer for JNE destination master data.
 *
 * ---------------------------------------------------------------------------
 * RAW IS AUTHORITATIVE
 *
 * `rawName` is carried through byte-for-byte. The normalised and parsed fields
 * are DERIVED COMPANIONS, never replacements. That matters because the observed
 * sandbox dataset is messy in ways that are themselves evidence: 1,370 rows have
 * spacing around the comma, 566 have leading or trailing whitespace, and one row
 * splits into three parts where two were meant (`LUBUKSIKAPING,KAB,PASAMAN`).
 * Normalising on write would erase exactly the detail a reviewer needs to judge
 * a mapping later.
 *
 * ---------------------------------------------------------------------------
 * NO I/O
 *
 * This module has no HTTP client, no filesystem access and no Prisma import, so
 * it cannot fetch, cannot write, and can be exercised entirely from a fixture.
 */

export type JneLocationKind = 'ORIGIN' | 'DESTINATION';
export type JneDataSource = 'SANDBOX' | 'PRODUCTION';

/** One row exactly as `/insert/getdestination` returns it. */
export interface JneMasterRaw {
  City_Name: string;
  City_Code: string;
}

/** A row ready to persist. `rawName` is untouched. */
export interface JneLocationSeed {
  code: string;
  rawName: string;
  normalizedName: string;
  parsedChild: string;
  parsedParent: string | null;
  partCount: number;
  kind: JneLocationKind;
  source: JneDataSource;
  sourceFetchedAt: string;
  isActive: boolean;
}

/**
 * Codes that are not real destinations. Observed verbatim in the sandbox
 * payload; kept rather than dropped so a later refresh can show they are gone.
 */
export const SANDBOX_TEST_CODES = ['TEST', 'XXWWQEQ'] as const;

/** JNE's real codes are three uppercase letters (an IATA hub) plus digits. */
export const JNE_CODE_PATTERN = /^[A-Z]{3}\d+$/;

export function isTestCode(code: string): boolean {
  return (SANDBOX_TEST_CODES as readonly string[]).includes(code.trim().toUpperCase());
}

/**
 * Uppercase, collapse runs of whitespace, normalise spacing around commas, trim.
 * Deliberately does NOT expand abbreviations (`KAB.`, `BRT`) or fix spelling:
 * `BANDUG` stays `BANDUG` so the typo remains visible to a reviewer.
 */
export function normalizeJneName(value: string): string {
  return value
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ',')
    .trim();
}

/**
 * Split a normalised name into child and parent.
 *
 * "CIBIRU,BANDUNG" -> child CIBIRU, parent BANDUNG
 * "BANDUNG"        -> child BANDUNG, parent null   (the 539-row city tier)
 *
 * The parent is the LAST part, not the second: `LUBUKSIKAPING,KAB,PASAMAN`
 * should read as Lubuksikaping in Kab. Pasaman, and the international rows
 * (`ANGUILA, ALL CITY, CARIBBEAN`) follow the same shape.
 */
export function parseJneName(normalized: string): { child: string; parent: string | null; partCount: number } {
  const parts = normalized
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return { child: '', parent: null, partCount: 0 };
  return {
    child: parts[0],
    parent: parts.length > 1 ? parts[parts.length - 1] : null,
    partCount: parts.length,
  };
}

export class JneMasterValidationError extends Error {
  constructor(reason: string) {
    super(`JNE master data is unusable: ${reason}`);
    this.name = 'JneMasterValidationError';
  }
}

/**
 * Validate the payload envelope and rows. FAILS CLOSED — a malformed source is
 * never silently repaired, because a quietly-dropped row is indistinguishable
 * from a destination JNE genuinely does not serve.
 */
export function validateJneMasterPayload(body: unknown): JneMasterRaw[] {
  if (!body || typeof body !== 'object') throw new JneMasterValidationError('payload is not an object');
  const detail = (body as { detail?: unknown }).detail;
  if (!Array.isArray(detail)) throw new JneMasterValidationError('`detail` is missing or not an array');
  if (detail.length === 0) throw new JneMasterValidationError('`detail` is empty');

  const seen = new Map<string, number>();
  const rows: JneMasterRaw[] = [];
  detail.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object') throw new JneMasterValidationError(`row ${i} is not an object`);
    const r = entry as Record<string, unknown>;
    if (typeof r.City_Name !== 'string') throw new JneMasterValidationError(`row ${i} has no string City_Name`);
    if (typeof r.City_Code !== 'string') throw new JneMasterValidationError(`row ${i} has no string City_Code`);
    if (!r.City_Name.trim()) throw new JneMasterValidationError(`row ${i} has a blank City_Name`);
    if (!r.City_Code.trim()) throw new JneMasterValidationError(`row ${i} has a blank City_Code`);
    // A duplicate code would make the natural key ambiguous; the observed
    // dataset has none, so one appearing means the source changed shape.
    const prev = seen.get(r.City_Code);
    if (prev !== undefined) {
      throw new JneMasterValidationError(`duplicate City_Code "${r.City_Code}" at rows ${prev} and ${i}`);
    }
    seen.set(r.City_Code, i);
    rows.push({ City_Name: r.City_Name, City_Code: r.City_Code });
  });
  return rows;
}

export interface TransformOptions {
  kind?: JneLocationKind;
  source?: JneDataSource;
  sourceFetchedAt: string;
}

/**
 * Raw rows -> persistable seeds. Pure and total.
 *
 * A row is INACTIVE when its code is a known sandbox test code or does not look
 * like a JNE code at all. Inactive rather than excluded: dropping it would make
 * the import unreproducible and hide the sandbox/production difference.
 */
export function toJneLocationSeeds(rows: JneMasterRaw[], options: TransformOptions): JneLocationSeed[] {
  const kind = options.kind ?? 'DESTINATION';
  const source = options.source ?? 'SANDBOX';
  return rows.map((r) => {
    const normalizedName = normalizeJneName(r.City_Name);
    const { child, parent, partCount } = parseJneName(normalizedName);
    const code = r.City_Code;
    return {
      code,
      rawName: r.City_Name, // VERBATIM - never trimmed, never rewritten
      normalizedName,
      parsedChild: child,
      parsedParent: parent,
      partCount,
      kind,
      source,
      sourceFetchedAt: options.sourceFetchedAt,
      isActive: !isTestCode(code) && JNE_CODE_PATTERN.test(code),
    };
  });
}

export interface ImportDiff {
  sourceRows: number;
  uniqueCodes: number;
  newCodes: string[];
  existingCodes: string[];
  changedRawName: Array<{ code: string; from: string; to: string }>;
  deactivatedCodes: string[];
  invalidOrTestCodes: string[];
}

/**
 * What an import WOULD do, computed before anything is written.
 *
 * `deactivatedCodes` are codes present in the database but absent from the new
 * snapshot: they are deactivated, never deleted, so a reviewed mapping can
 * never dangle.
 */
export function computeImportDiff(
  seeds: JneLocationSeed[],
  existing: Array<{ code: string; rawName: string }>,
): ImportDiff {
  const existingByCode = new Map(existing.map((e) => [e.code, e.rawName]));
  const incoming = new Set(seeds.map((s) => s.code));

  const newCodes: string[] = [];
  const existingCodes: string[] = [];
  const changedRawName: ImportDiff['changedRawName'] = [];

  for (const s of seeds) {
    const prev = existingByCode.get(s.code);
    if (prev === undefined) {
      newCodes.push(s.code);
      continue;
    }
    existingCodes.push(s.code);
    if (prev !== s.rawName) changedRawName.push({ code: s.code, from: prev, to: s.rawName });
  }

  return {
    sourceRows: seeds.length,
    uniqueCodes: incoming.size,
    newCodes,
    existingCodes,
    changedRawName,
    deactivatedCodes: existing.map((e) => e.code).filter((c) => !incoming.has(c)),
    invalidOrTestCodes: seeds.filter((s) => !s.isActive).map((s) => s.code),
  };
}

/** The row count the PAXELBOX-61C snapshot contained. */
export const EXPECTED_SANDBOX_ROWS = 8322;

/**
 * Refuse an unexpected snapshot size unless an operator overrides it. A source
 * that silently halved would otherwise deactivate thousands of destinations.
 */
export function assertExpectedRowCount(actual: number, expected = EXPECTED_SANDBOX_ROWS, override = false): void {
  if (actual === expected || override) return;
  throw new JneMasterValidationError(
    `snapshot has ${actual} rows but ${expected} were expected; pass the explicit override if this change is intended`,
  );
}
