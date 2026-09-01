/**
 * PAXELBOX-51: OFFLINE acquisition infrastructure for the RajaOngkir destination
 * dataset. Implemented here; NOT executed. There is no auto-running entry point.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TRANSPORT AND STORAGE ARE INJECTED
 *
 * This module never constructs an HTTP client and never touches `fs` or `process.env`.
 * Both are parameters. That is not only for testability: it means the module is
 * STRUCTURALLY incapable of reaching RajaOngkir or of writing anywhere on its own,
 * so a stray import can never start spending a quota we have not measured.
 *
 * ---------------------------------------------------------------------------
 * WHY IT STOPS RATHER THAN CONTINUES
 *
 * A 429 means the daily quota is spent (PAXELBOX-41C/47). Continuing would burn
 * more of it to be told the same thing, and — far worse — turning a 429 into an
 * empty page would silently record "this province has no destinations", poisoning
 * the dataset a customer's shipping price is later computed from. Every failure
 * therefore stops the run with the checkpoint intact, and the next run resumes.
 */

import type { RajaOngkirDestination } from './rajaongkir-village-map';

// ---------------------------------------------------------------- adapter

/** A destination row exactly as RajaOngkir returns it (snake_case, untouched). */
export interface RajaOngkirDestinationRaw {
  id: number;
  label: string;
  province_name: string;
  city_name: string;
  district_name: string;
  subdistrict_name: string;
  zip_code: string | null;
}

/**
 * snake_case wire shape -> the mapper's camelCase shape. Pure.
 *
 * `label` is deliberately dropped: it is a display concatenation of the other
 * fields, so carrying it into matching would invite someone to match on it.
 */
export function toDestination(raw: RajaOngkirDestinationRaw): RajaOngkirDestination {
  return {
    id: raw.id,
    provinceName: raw.province_name,
    cityName: raw.city_name,
    districtName: raw.district_name,
    subdistrictName: raw.subdistrict_name,
    zipCode: raw.zip_code,
  };
}

export function toDestinations(rows: RajaOngkirDestinationRaw[]): RajaOngkirDestination[] {
  return rows.map(toDestination);
}

// -------------------------------------------------------------- validator

export type EnvelopeResult =
  | { kind: 'success'; rows: RajaOngkirDestinationRaw[] }
  | { kind: 'api_error'; code: number; message: string }
  | { kind: 'malformed'; reason: string };

const REQUIRED_FIELDS = [
  'id', 'label', 'province_name', 'city_name', 'district_name', 'subdistrict_name', 'zip_code',
] as const;

function isRow(value: unknown): value is RajaOngkirDestinationRaw {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  if (typeof r.id !== 'number' || !Number.isFinite(r.id)) return false;
  for (const f of REQUIRED_FIELDS) {
    if (!(f in r)) return false;
  }
  // zip_code may be null; every other string field must actually be a string.
  for (const f of ['label', 'province_name', 'city_name', 'district_name', 'subdistrict_name'] as const) {
    if (typeof r[f] !== 'string') return false;
  }
  if (r.zip_code !== null && typeof r.zip_code !== 'string') return false;
  return true;
}

/**
 * Classify a response body. Three outcomes, never conflated:
 *
 *  - success    meta.code 200 and every row well-formed
 *  - api_error  the API answered, and said no (429 "Daily limit exceeded", 401, …)
 *  - malformed  we cannot trust what came back
 *
 * A malformed row is NEVER coerced into a destination and never dropped
 * silently: one bad row invalidates the page, because a page that quietly
 * shrinks is indistinguishable from a page that legitimately had fewer rows.
 */
export function validateEnvelope(body: unknown): EnvelopeResult {
  if (!body || typeof body !== 'object') return { kind: 'malformed', reason: 'body is not an object' };
  const b = body as { meta?: unknown; data?: unknown };

  if (!b.meta || typeof b.meta !== 'object') return { kind: 'malformed', reason: 'missing meta' };
  const meta = b.meta as { code?: unknown; message?: unknown; status?: unknown };
  if (typeof meta.code !== 'number') return { kind: 'malformed', reason: 'meta.code is not a number' };

  if (meta.code !== 200) {
    return { kind: 'api_error', code: meta.code, message: String(meta.message ?? 'unknown') };
  }
  if (!Array.isArray(b.data)) return { kind: 'malformed', reason: 'meta.code is 200 but data is not an array' };

  for (let i = 0; i < b.data.length; i++) {
    if (!isRow(b.data[i])) return { kind: 'malformed', reason: `row ${i} is missing or has malformed fields` };
  }
  return { kind: 'success', rows: b.data as RajaOngkirDestinationRaw[] };
}

// ------------------------------------------------------ failure semantics

export type FailureCategory =
  | 'RATE_LIMITED'
  | 'AUTHENTICATION_FAILED'
  | 'HTTP_ERROR'
  | 'MALFORMED_RESPONSE'
  | 'NETWORK_ERROR'
  /**
   * PAXELBOX-56: a paginated unit hit its page ceiling while the last page was
   * still full, so the search result set was NOT proven exhausted. Responses
   * carry no total count (PAXELBOX-52D), so a full final page is indistinguishable
   * from a truncated one — the only honest answer is to fail. This must never
   * become NOT_FOUND, MATCHED or AMBIGUOUS: a truncated pool turns a real
   * destination into "no such place", which is exactly the silent corruption
   * this module exists to prevent.
   */
  | 'INCOMPLETE_RESULT_SET'
  | 'UNKNOWN_ERROR';

/**
 * Every category stops the run. None advances the checkpoint past the failing
 * unit, and none stores a raw file for it, so a resume retries exactly that unit
 * and nothing is ever recorded as "acquired" on the strength of a failure.
 *
 * Stopping on 5xx and network errors too is deliberate and slightly stricter
 * than the shipping client's in-call retry: this is a long batch against an
 * unmeasured quota, and a resume costs nothing, whereas a run that limps on
 * through a provider outage produces a dataset nobody can trust.
 */
export const FAILURE_STOPS_RUN: Record<FailureCategory, true> = {
  RATE_LIMITED: true,
  AUTHENTICATION_FAILED: true,
  HTTP_ERROR: true,
  MALFORMED_RESPONSE: true,
  NETWORK_ERROR: true,
  INCOMPLETE_RESULT_SET: true,
  UNKNOWN_ERROR: true,
};

/**
 * PAXELBOX-60B: the one RajaOngkir response that means "this search matched
 * nothing", spelled as an HTTP error.
 *
 * PAXELBOX-60 hit `search=Astanaanyar` and got 404 with this message. Every
 * design decision before that assumed an empty result arrives as `200` with
 * `data: []`. It does not, and the cost of the wrong assumption was a run that
 * halted on a district whose name RajaOngkir simply does not know — which is a
 * NOT_FOUND for that district's villages, not a fault.
 *
 * The match is deliberately narrow, and every clause earns its place: a plain
 * 404 from a proxy, a 404 on a different endpoint, or a 404 whose message the
 * API later changes all remain HTTP_ERROR and still stop the run. Widening this
 * would turn real failures into "there is nothing there", which is exactly the
 * silent data loss this module exists to prevent. Fail-closed is the safe
 * direction here: an unrecognised 404 costs one stopped run, whereas a
 * mis-classified one costs a district that quietly maps to nothing.
 */
export const EMPTY_SEARCH_MESSAGE = 'Domestic Destinations Data not found';

export function isEmptySearchResponse(status: number, body: unknown): boolean {
  if (status !== 404) return false;
  if (!body || typeof body !== 'object') return false;
  const b = body as { meta?: unknown; data?: unknown };
  // Observed shape carries an explicit null payload. A 404 that somehow arrived
  // WITH rows is not an empty result and must not be read as one.
  if (b.data !== null && b.data !== undefined) return false;
  if (!b.meta || typeof b.meta !== 'object') return false;
  const meta = b.meta as { code?: unknown; message?: unknown };
  if (meta.code !== 404) return false;
  // Exact (trimmed) message, not a substring: "…not found for province" is a
  // different answer and we do not get to guess what it means.
  return typeof meta.message === 'string' && meta.message.trim() === EMPTY_SEARCH_MESSAGE;
}

export function categorizeHttp(status: number): FailureCategory {
  if (status === 429) return 'RATE_LIMITED';
  if (status === 401 || status === 403) return 'AUTHENTICATION_FAILED';
  if (status >= 400) return 'HTTP_ERROR';
  return 'UNKNOWN_ERROR';
}

// ------------------------------------------------------------- checkpoint

/** Bump when the checkpoint shape changes; an older version is not resumed blindly. */
export const CHECKPOINT_VERSION = 1;

export interface CheckpointFailure {
  unit: string;
  category: FailureCategory;
  httpStatus?: number;
  message: string;
  at: string;
}

export interface Checkpoint {
  version: number;
  acquisitionId: string;
  /** Unit keys whose raw response is stored and trusted. */
  completedUnits: string[];
  /** Set when a run stopped; cleared on the next successful unit. */
  failure?: CheckpointFailure;
  updatedAt: string;
}

export function emptyCheckpoint(acquisitionId: string, now: string): Checkpoint {
  return { version: CHECKPOINT_VERSION, acquisitionId, completedUnits: [], updatedAt: now };
}

/**
 * A checkpoint is only resumable when it is complete AND of the current version.
 * Anything else is treated as "start over", never as "everything is done" — a
 * half-written file must not be able to make the runner skip real work.
 */
export function isResumable(value: unknown): value is Checkpoint {
  if (!value || typeof value !== 'object') return false;
  const c = value as Partial<Checkpoint>;
  return (
    c.version === CHECKPOINT_VERSION &&
    typeof c.acquisitionId === 'string' &&
    Array.isArray(c.completedUnits) &&
    c.completedUnits.every((u) => typeof u === 'string') &&
    typeof c.updatedAt === 'string'
  );
}

// ---------------------------------------------------------------- storage

/**
 * Everything the runner is allowed to touch. A real filesystem implementation
 * lives outside this module; tests supply an in-memory one, so no test writes
 * to disk.
 *
 * `writeCheckpoint` MUST be atomic (temp file -> rename). A reader must never
 * observe a partially-written checkpoint.
 */
export interface AcquisitionStorage {
  readCheckpoint(): Promise<unknown | null>;
  writeCheckpoint(checkpoint: Checkpoint): Promise<void>;
  /** Persist one unit's response VERBATIM. Returns the artifact name. */
  writeRaw(unitKey: string, body: unknown): Promise<string>;
  /**
   * PAXELBOX-60F-B: read back one completed unit's artifact, VERBATIM.
   *
   * Required, not optional. A resumed run skips units the checkpoint already
   * claims, so without this the mapping pool silently loses every district
   * acquired on an earlier day. An implementation that could omit this would
   * reintroduce exactly that under-reporting.
   *
   * MUST throw when the artifact is missing or unreadable - never return an
   * empty result, which is indistinguishable from a district that genuinely
   * has no destinations.
   */
  readRaw(unitKey: string): Promise<unknown>;
}

/**
 * Deterministic, traversal-safe artifact name for a unit.
 *
 * Everything outside [a-z0-9._-] collapses to '-', and any leading dots are
 * stripped, so a unit key can never escape its directory or produce a dotfile.
 * Deterministic so a resume overwrites the same artifact rather than
 * accumulating duplicates.
 */
export function rawFileName(unitKey: string): string {
  const safe = unitKey
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[.\-]+/, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 120);
  return `${safe || 'unit'}.json`;
}

// ----------------------------------------------------------------- runner

/**
 * One request the plan intends to make. The runner does NOT build these: the
 * caller supplies them, because pagination semantics, the maximum `limit` and
 * whether an empty `search` enumerates are all UNKNOWN (PAXELBOX-50) and must
 * not be baked in as assumptions.
 */
export interface AcquisitionUnit {
  /** Stable identity for checkpointing, e.g. "province" or "city-32-offset-0". */
  key: string;
  /** Fully-formed URL. Credentials travel in the transport's headers, never here. */
  url: string;
}

export interface TransportResponse {
  status: number;
  body: unknown;
}

/**
 * Performs one request. Supplied by the caller so this module holds no HTTP
 * client and no credentials — the key lives in the transport's closure and
 * never reaches the runner, the checkpoint or the raw cache.
 */
export type AcquisitionTransport = (url: string) => Promise<TransportResponse>;

export interface AcquisitionResult {
  attempted: number;
  succeeded: number;
  skipped: number;
  stopped: boolean;
  failure?: CheckpointFailure;
  checkpoint: Checkpoint;
}

export interface RunOptions {
  acquisitionId: string;
  now?: () => string;
}

/**
 * Walk the planned units in order, storing each successful raw response and
 * advancing the checkpoint after it. Units already recorded as completed are
 * skipped, so an interrupted run resumes rather than restarting.
 *
 * The first failure of any kind stops the walk. Nothing after it is attempted,
 * which is what keeps a spent quota from being spent further.
 */
export async function runAcquisition(
  units: AcquisitionUnit[],
  transport: AcquisitionTransport,
  storage: AcquisitionStorage,
  options: RunOptions,
): Promise<AcquisitionResult> {
  const now = options.now ?? (() => new Date().toISOString());

  const stored = await storage.readCheckpoint();
  const checkpoint: Checkpoint = isResumable(stored)
    ? { ...stored, completedUnits: [...stored.completedUnits] }
    : emptyCheckpoint(options.acquisitionId, now());

  const done = new Set(checkpoint.completedUnits);
  let attempted = 0;
  let succeeded = 0;
  let skipped = 0;

  for (const unit of units) {
    if (done.has(unit.key)) {
      skipped += 1;
      continue;
    }

    attempted += 1;
    let response: TransportResponse;
    try {
      response = await transport(unit.url);
    } catch (err) {
      return stop(unit.key, 'NETWORK_ERROR', undefined, err instanceof Error ? err.message : String(err));
    }

    if (response.status !== 200) {
      const category = categorizeHttp(response.status);
      // The body is inspected only to quote the API's own words back; a non-200
      // is a failure whatever it says, and is NEVER read as an empty dataset.
      const parsed = validateEnvelope(response.body);
      const detail = parsed.kind === 'api_error' ? parsed.message : `HTTP ${response.status}`;
      return stop(unit.key, category, response.status, detail);
    }

    const envelope = validateEnvelope(response.body);
    if (envelope.kind === 'api_error') {
      // 200 carrying an error envelope — still an API refusal, never data.
      return stop(unit.key, categorizeHttp(envelope.code), envelope.code, envelope.message);
    }
    if (envelope.kind === 'malformed') {
      return stop(unit.key, 'MALFORMED_RESPONSE', response.status, envelope.reason);
    }

    // Success: store the response VERBATIM, then advance. In that order — a
    // checkpoint must never claim a unit whose artifact was not written.
    await storage.writeRaw(unit.key, response.body);
    checkpoint.completedUnits.push(unit.key);
    delete checkpoint.failure;
    checkpoint.updatedAt = now();
    await storage.writeCheckpoint({ ...checkpoint, completedUnits: [...checkpoint.completedUnits] });
    succeeded += 1;
  }

  return { attempted, succeeded, skipped, stopped: false, checkpoint };

  async function stop(
    unit: string,
    category: FailureCategory,
    httpStatus: number | undefined,
    message: string,
  ): Promise<AcquisitionResult> {
    const failure: CheckpointFailure = { unit, category, httpStatus, message, at: now() };
    checkpoint.failure = failure;
    checkpoint.updatedAt = now();
    // The failing unit is NOT added to completedUnits, so a resume retries it.
    await storage.writeCheckpoint({ ...checkpoint, completedUnits: [...checkpoint.completedUnits] });
    return { attempted, succeeded, skipped, stopped: true, failure, checkpoint };
  }
}

// ------------------------------------------------- paginated runner (56)

/**
 * PAXELBOX-56: acquisition for a search term whose result set may span pages.
 *
 * The non-paginated `runAcquisition` above takes fully-formed URLs because in
 * PAXELBOX-51 pagination semantics were still unknown. They are known now
 * (PAXELBOX-52D: `offset`/`limit` work; PAXELBOX-52B/56: NO total-count field
 * exists), and that changes who must own the loop. The only signal that a
 * result set is exhausted is a SHORT page, which can only be read from the
 * response — so a caller handing over a static list of offsets cannot know when
 * to stop, and pre-provisioning "enough" offsets both burns an unmeasured quota
 * on empty pages and still cannot PROVE exhaustion. The runner therefore owns
 * the offsets, and the caller supplies a function to build a URL from one.
 */
export interface PaginatedAcquisitionUnit {
  /** Stable identity for checkpointing, e.g. "district-gedebage". */
  key: string;
  /** The search term, recorded in the artifact so a reviewer can reproduce the run. */
  searchTerm: string;
  /** Builds the URL for one page. Credentials travel in the transport's headers, never here. */
  urlFor(offset: number): string;
  /** Page size sent as `limit`. A page with fewer rows than this ends the unit. */
  limit: number;
}

/** One fully-acquired unit: every page fetched, exhaustion proven, ids deduplicated. */
export interface AcquiredUnit {
  key: string;
  searchTerm: string;
  limit: number;
  /** Offsets requested, in request order. */
  offsets: number[];
  /** Rows across all pages, deduplicated by id, first occurrence wins. */
  rows: RajaOngkirDestinationRaw[];
}

export interface PaginatedRunOptions extends RunOptions {
  /**
   * Hard ceiling on pages per unit. Reaching it with a still-full page is a
   * FAILURE (`INCOMPLETE_RESULT_SET`), never a quiet truncation.
   */
  maxPages?: number;
}

export const DEFAULT_MAX_PAGES = 20;

export interface PaginatedAcquisitionResult {
  /** HTTP requests actually issued, across all units. */
  requests: number;
  unitsCompleted: number;
  unitsSkipped: number;
  stopped: boolean;
  failure?: CheckpointFailure;
  checkpoint: Checkpoint;
  /** Only units proven complete. A stopped unit never appears here. */
  acquired: AcquiredUnit[];
}

/**
 * Acquire each unit by walking its pages to exhaustion, then store ONE artifact
 * for the whole unit and only then advance the checkpoint.
 *
 * Ordering is load-bearing throughout: nothing is checkpointed mid-pagination,
 * after a partial page, at the page ceiling, or after any failure — so a resume
 * always re-acquires a unit that was not proven complete, and `completedUnits`
 * never contains a unit whose artifact is missing or truncated.
 */
export async function runPaginatedAcquisition(
  units: PaginatedAcquisitionUnit[],
  transport: AcquisitionTransport,
  storage: AcquisitionStorage,
  options: PaginatedRunOptions,
): Promise<PaginatedAcquisitionResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;

  const stored = await storage.readCheckpoint();
  const checkpoint: Checkpoint = isResumable(stored)
    ? { ...stored, completedUnits: [...stored.completedUnits] }
    : emptyCheckpoint(options.acquisitionId, now());

  const done = new Set(checkpoint.completedUnits);
  const acquired: AcquiredUnit[] = [];
  let requests = 0;
  let unitsCompleted = 0;
  let unitsSkipped = 0;

  for (const unit of units) {
    if (done.has(unit.key)) {
      unitsSkipped += 1;
      continue;
    }

    const offsets: number[] = [];
    const pages: Array<{ offset: number; rows: RajaOngkirDestinationRaw[] }> = [];
    const rows: RajaOngkirDestinationRaw[] = [];
    const seen = new Set<number>();
    let offset = 0;

    // Walk pages until a short page proves the set is exhausted.
    for (;;) {
      if (pages.length >= maxPages) {
        // Only reachable when the previous page was FULL — a short page breaks
        // out below. So the set is genuinely unproven, not merely large.
        return stop(
          unit.key,
          'INCOMPLETE_RESULT_SET',
          undefined,
          `page ceiling ${maxPages} reached for search "${unit.searchTerm}" with a full final page; result set not proven complete`,
        );
      }

      let response: TransportResponse;
      try {
        requests += 1;
        response = await transport(unit.urlFor(offset));
      } catch (err) {
        return stop(unit.key, 'NETWORK_ERROR', undefined, err instanceof Error ? err.message : String(err));
      }

      // A search that matched nothing (PAXELBOX-60B). Handled exactly like a
      // `200` with `data: []`: the page is recorded empty, which is a short page,
      // which ends the unit as legitimately complete. The unit then holds zero
      // rows, so the matcher sees no candidate and says NOT_FOUND — and the walk
      // moves on to the next district instead of halting the run.
      if (isEmptySearchResponse(response.status, response.body)) {
        offsets.push(offset);
        pages.push({ offset, rows: [] });
        break;
      }

      if (response.status !== 200) {
        const category = categorizeHttp(response.status);
        const parsed = validateEnvelope(response.body);
        const detail = parsed.kind === 'api_error' ? parsed.message : `HTTP ${response.status}`;
        return stop(unit.key, category, response.status, detail);
      }

      const envelope = validateEnvelope(response.body);
      if (envelope.kind === 'api_error') {
        // 200 carrying an error envelope (data is typically null) — an API
        // refusal, never an empty result set.
        return stop(unit.key, categorizeHttp(envelope.code), envelope.code, envelope.message);
      }
      if (envelope.kind === 'malformed') {
        return stop(unit.key, 'MALFORMED_RESPONSE', response.status, envelope.reason);
      }

      offsets.push(offset);
      pages.push({ offset, rows: envelope.rows });
      // Deduplicate by numeric id only. Never by name and never by postal code:
      // distinct destinations legitimately share both, and collapsing them would
      // hide an ambiguity the matcher must be allowed to see.
      for (const row of envelope.rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        rows.push(row);
      }

      if (envelope.rows.length < unit.limit) break; // exhausted
      offset += unit.limit;
    }

    // One artifact for the whole unit, written BEFORE the checkpoint claims it.
    // URLs are deliberately not recorded: they are the only place a caller could
    // have put a credential, and an artifact is meant to be shareable for review.
    await storage.writeRaw(unit.key, {
      key: unit.key,
      searchTerm: unit.searchTerm,
      limit: unit.limit,
      offsets,
      pages,
      candidateIds: rows.map((r) => r.id),
    });

    acquired.push({ key: unit.key, searchTerm: unit.searchTerm, limit: unit.limit, offsets, rows });
    checkpoint.completedUnits.push(unit.key);
    delete checkpoint.failure;
    checkpoint.updatedAt = now();
    await storage.writeCheckpoint({ ...checkpoint, completedUnits: [...checkpoint.completedUnits] });
    unitsCompleted += 1;
  }

  return { requests, unitsCompleted, unitsSkipped, stopped: false, checkpoint, acquired };

  async function stop(
    unit: string,
    category: FailureCategory,
    httpStatus: number | undefined,
    message: string,
  ): Promise<PaginatedAcquisitionResult> {
    const failure: CheckpointFailure = { unit, category, httpStatus, message, at: now() };
    checkpoint.failure = failure;
    checkpoint.updatedAt = now();
    // The failing unit is NOT added to completedUnits, and no artifact was
    // written for it, so a resume re-acquires it from offset 0.
    await storage.writeCheckpoint({ ...checkpoint, completedUnits: [...checkpoint.completedUnits] });
    return { requests, unitsCompleted, unitsSkipped, stopped: true, failure, checkpoint, acquired };
  }
}

/**
 * Flatten acquired units into the candidate pool the matcher consumes,
 * deduplicated by id across units — the same destination legitimately appears
 * in two units when their search terms overlap.
 */
export function poolFrom(acquired: AcquiredUnit[]): RajaOngkirDestination[] {
  const seen = new Set<number>();
  const out: RajaOngkirDestination[] = [];
  for (const unit of acquired) {
    for (const row of unit.rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push(toDestination(row));
    }
  }
  return out;
}
