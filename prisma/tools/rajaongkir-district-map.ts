/**
 * PAXELBOX-41: Kemendagri district -> RajaOngkir district id, resolved OFFLINE.
 *
 * ---------------------------------------------------------------------------
 * WHY OFFLINE
 *
 * RajaOngkir prices by its own numeric district id, not by postal code. The
 * obvious shortcut - call `/destination/domestic-destination?search=` during
 * checkout - is the one approach that must not be taken: it is a name search,
 * it can return several candidates for one district, and a wrong pick silently
 * misprices an order the customer then pays. It also spends a request of an
 * unpublished quota on every quote.
 *
 * So identity is resolved ONCE, offline, reviewed, and stored - the same shape
 * as `import-regions.ts`, which turns the Kemendagri dump into
 * `regions.full.json` for an idempotent seeder that needs no network.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS
 *
 * The pure decision logic ONLY: it takes both sides as plain data and returns a
 * report. No Prisma, no HTTP, no filesystem, no env - so every rule below is
 * unit-testable without a database or a network, and running it twice on the
 * same input gives byte-identical output.
 *
 * Fetching the RajaOngkir side is a SEPARATE, authenticated, human-run step
 * (`GET /destination/district/{city_id}`, header `key`) whose output is saved as
 * a dataset file. This module never performs it.
 * ---------------------------------------------------------------------------
 */

/** One Massular district, as held in the Kemendagri master. */
export interface MassularDistrict {
  /** Kemendagri code, e.g. "32.09.29". */
  code: string;
  name: string;
  cityName: string;
  provinceName: string;
}

/** One RajaOngkir district, as returned by GET /destination/district/{city_id}. */
export interface RajaOngkirDistrict {
  /** JSON number in the API response, e.g. 1361. */
  id: number;
  name: string;
  cityName: string;
  provinceName: string;
  /** RajaOngkir sends "0" for rows that are not a real kecamatan. */
  zipCode?: string;
}

export type MatchOutcome = 'MATCH' | 'AMBIGUOUS' | 'NOT_FOUND';

export interface DistrictMatch {
  code: string;
  provinceName: string;
  cityName: string;
  districtName: string;
  outcome: MatchOutcome;
  /** Only set when outcome === 'MATCH'. */
  rajaOngkirId?: number;
  /** Every candidate considered, so an AMBIGUOUS row can be reviewed by hand. */
  candidateIds: number[];
}

export interface MappingReport {
  total: number;
  matched: number;
  notFound: number;
  ambiguous: number;
  /** RajaOngkir ids that matched more than one Massular district. */
  duplicateIds: number[];
  matches: DistrictMatch[];
  /** True only when the result is safe to write. */
  safeToApply: boolean;
  blockers: string[];
}

/**
 * Normalise a name for comparison.
 *
 * Deliberately conservative: case, surrounding whitespace, repeated spaces and
 * punctuation only. It does NOT strip administrative prefixes (KOTA, KAB.,
 * KECAMATAN) or attempt stemming, abbreviation expansion or edit-distance -
 * every one of those turns a mismatch into a plausible-looking wrong answer,
 * which is the failure this whole design exists to avoid. Anything that does
 * not match after this much normalisation is reported for a human instead.
 */
export function normalizeName(value: string): string {
  return value
    .normalize('NFKD')
    .toUpperCase()
    .replace(/[.,''`-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Full hierarchy key: a district name alone is never enough to identify one. */
function hierarchyKey(provinceName: string, cityName: string, districtName: string): string {
  return [normalizeName(provinceName), normalizeName(cityName), normalizeName(districtName)].join('|');
}

/**
 * RajaOngkir's district list contains rows that are not kecamatan - the city
 * itself appears with `zip_code: "0"` (e.g. "JAKARTA SELATAN" alongside the real
 * "JAGAKARSA"). Those are aggregates, not administrative districts, and matching
 * one would attach a city-level id to a kecamatan row.
 *
 * They are dropped rather than matched. A district that only ever matches an
 * aggregate therefore ends up NOT_FOUND - correctly, because we could not
 * identify it.
 */
export function isAggregateRow(row: RajaOngkirDistrict): boolean {
  return (row.zipCode ?? '').trim() === '0';
}

/**
 * Match on EXACT province + city + district. No name-only match, no postal-code
 * match, no fuzzy similarity, and no "first result wins".
 *
 * Several candidates for one key is a FAILURE, not a choice to make: the tool
 * reports AMBIGUOUS and refuses to emit anything for that district.
 */
export function mapDistricts(
  massular: MassularDistrict[],
  rajaongkir: RajaOngkirDistrict[],
): MappingReport {
  const byKey = new Map<string, RajaOngkirDistrict[]>();
  for (const row of rajaongkir) {
    if (isAggregateRow(row)) continue;
    const key = hierarchyKey(row.provinceName, row.cityName, row.name);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(row);
    else byKey.set(key, [row]);
  }

  const matches: DistrictMatch[] = [];
  for (const d of massular) {
    const candidates = byKey.get(hierarchyKey(d.provinceName, d.cityName, d.name)) ?? [];
    const base = {
      code: d.code,
      provinceName: d.provinceName,
      cityName: d.cityName,
      districtName: d.name,
      candidateIds: candidates.map((c) => c.id),
    };

    if (candidates.length === 1) {
      matches.push({ ...base, outcome: 'MATCH', rajaOngkirId: candidates[0].id });
    } else if (candidates.length > 1) {
      // Distinct ids under one hierarchy key: RajaOngkir itself is ambiguous here.
      matches.push({ ...base, outcome: 'AMBIGUOUS' });
    } else {
      matches.push({ ...base, outcome: 'NOT_FOUND' });
    }
  }

  // One RajaOngkir id claimed by two districts means at least one is wrong.
  const idOwners = new Map<number, string[]>();
  for (const m of matches) {
    if (m.outcome !== 'MATCH' || m.rajaOngkirId === undefined) continue;
    const owners = idOwners.get(m.rajaOngkirId);
    if (owners) owners.push(m.code);
    else idOwners.set(m.rajaOngkirId, [m.code]);
  }
  const duplicateIds = [...idOwners.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([id]) => id)
    .sort((a, b) => a - b);

  const ambiguous = matches.filter((m) => m.outcome === 'AMBIGUOUS').length;
  const matched = matches.filter((m) => m.outcome === 'MATCH').length;
  const notFound = matches.filter((m) => m.outcome === 'NOT_FOUND').length;

  // Unmatched rows are fine - they simply stay NULL and yield no JNE quote.
  // Ambiguity and duplication are NOT fine: both mean the data is telling us
  // something we do not understand yet, and writing either would put a wrong
  // price in front of a customer.
  const blockers: string[] = [];
  if (ambiguous > 0) blockers.push(`${ambiguous} district(s) matched more than one RajaOngkir id`);
  if (duplicateIds.length > 0) blockers.push(`${duplicateIds.length} RajaOngkir id(s) claimed by multiple districts`);

  return {
    total: massular.length,
    matched,
    notFound,
    ambiguous,
    duplicateIds,
    matches,
    safeToApply: blockers.length === 0,
    blockers,
  };
}

/** The rows that may be written. Empty whenever the report is not safe to apply. */
export function applicableMappings(report: MappingReport): Array<{ code: string; rajaOngkirId: number }> {
  if (!report.safeToApply) return [];
  return report.matches
    .filter((m): m is DistrictMatch & { rajaOngkirId: number } => m.outcome === 'MATCH' && m.rajaOngkirId !== undefined)
    .map((m) => ({ code: m.code, rajaOngkirId: m.rajaOngkirId }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

/** Human-readable sample table for the review step. Never writes anything. */
export function formatSample(report: MappingReport, limit = 20): string {
  const lines = [
    `total=${report.total} matched=${report.matched} notFound=${report.notFound} ambiguous=${report.ambiguous}`,
    `duplicateIds=${report.duplicateIds.length} safeToApply=${report.safeToApply}`,
    '',
    'kemendagri      province / city / district                          -> rajaOngkirId  outcome',
  ];
  for (const m of report.matches.slice(0, limit)) {
    const where = `${m.provinceName} / ${m.cityName} / ${m.districtName}`;
    lines.push(
      `${m.code.padEnd(15)} ${where.padEnd(50).slice(0, 50)} -> ` +
        `${String(m.rajaOngkirId ?? '-').padEnd(12)} ${m.outcome}` +
        (m.outcome === 'AMBIGUOUS' ? ` [${m.candidateIds.join(', ')}]` : ''),
    );
  }
  return lines.join('\n');
}
