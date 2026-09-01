/**
 * PAXELBOX-49B: Kemendagri village -> RajaOngkir destination id, resolved OFFLINE.
 *
 * ---------------------------------------------------------------------------
 * WHY VILLAGE AND NOT DISTRICT
 *
 * A RajaOngkir destination row IS a subdistrict/kelurahan:
 *   { id: 4932, subdistrict_name: "CIPAMOKOLAN", district_name: "RANCASARI",
 *     city_name: "BANDUNG", province_name: "JAWA BARAT", zip_code: "40292" }
 *
 * The earlier district-level attempt was retired because a kecamatan holds 11.5
 * villages on average (max 108): one id per district would have priced every
 * address in the kecamatan as one arbitrary kelurahan.
 *
 * ---------------------------------------------------------------------------
 * WHY CITY IS NOT PART OF THE KEY
 *
 * RajaOngkir's `city_name` does NOT correspond to a Kemendagri city. Its
 * "CIREBON" contains all 5 Kota Cirebon kecamatan AND 36 of the 40 Kabupaten
 * Cirebon ones; its "BANDUNG" spans ten Kemendagri cities. Matching on it would
 * fail for every merged city.
 *
 * Its `district_name` DOES line up with kecamatan, so the key deliberately skips
 * the one level that is known incompatible:
 *
 *     province + district + subdistrict          (postal code VERIFIES)
 *
 * City is kept on the record for human review, never compared.
 *
 * ---------------------------------------------------------------------------
 * PURE: no Prisma, no HTTP, no filesystem, no env. Fetching the RajaOngkir side
 * is a separate, authenticated, human-run step whose output is a local file.
 * This module never performs it, so every rule below is testable offline and
 * running it twice on the same input gives byte-identical output.
 */

/** One Massular village, joined to its district/city/province. */
export interface MassularVillage {
  /** Kemendagri code, e.g. "32.73.23.1003" — unique, and the write-back key. */
  code: string;
  name: string;
  postalCode: string | null;
  districtName: string;
  /** Carried for review only; NEVER compared against RajaOngkir. */
  cityName: string;
  provinceName: string;
}

/** One RajaOngkir destination row, as returned by /destination/domestic-destination. */
export interface RajaOngkirDestination {
  /** JSON number in the API response, e.g. 4932. */
  id: number;
  provinceName: string;
  /** Present in the response; deliberately NOT used for matching. */
  cityName: string;
  districtName: string;
  subdistrictName: string;
  zipCode: string | null;
}

export type MatchOutcome = 'MATCHED' | 'AMBIGUOUS' | 'NOT_FOUND' | 'REVIEW_REQUIRED';

export interface VillageMatch {
  code: string;
  provinceName: string;
  cityName: string;
  districtName: string;
  villageName: string;
  outcome: MatchOutcome;
  /** Only set when outcome === 'MATCHED'. */
  rajaOngkirId?: number;
  /** Every candidate considered, so a non-match can be reviewed by hand. */
  candidateIds: number[];
  /** Why a human needs to look at this row. */
  reason?: string;
}

export interface VillageMappingReport {
  total: number;
  matched: number;
  ambiguous: number;
  notFound: number;
  reviewRequired: number;
  /** RajaOngkir ids claimed by more than one village. */
  duplicateIds: number[];
  matches: VillageMatch[];
  /** True only when the result is safe to write. */
  safeToApply: boolean;
  blockers: string[];
}

/**
 * Conservative normalisation — identical to the district tool it replaces.
 *
 * Case, surrounding whitespace, repeated spaces and punctuation ONLY. It does
 * not strip administrative prefixes (KOTA, KABUPATEN, DESA, KELURAHAN), expand
 * abbreviations, apply edit distance or phonetics. Every one of those turns a
 * mismatch into a plausible-looking wrong answer, which is the failure this
 * design exists to avoid.
 *
 * Consequence, accepted deliberately: RajaOngkir's "DARWATI" and our "Derwati"
 * do NOT match here. That row becomes REVIEW_REQUIRED for a human to confirm —
 * a rule that folds a<->e would silently merge genuinely distinct place names.
 */
export function normalizeName(value: string): string {
  return value
    .normalize('NFKD')
    .toUpperCase()
    .replace(/[.,''`-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Postal codes are compared digits-only; an absent code on either side is "unknown". */
function normalizeZip(value: string | null | undefined): string | null {
  const digits = (value ?? '').replace(/\D/g, '');
  return digits.length ? digits : null;
}

/**
 * province | district | subdistrict — city is deliberately absent.
 *
 * This alone is NOT unique. PAXELBOX-52B observed two live RajaOngkir rows
 * sharing it, separated only by city and postal code:
 *   JAWA TENGAH | KARANGANYAR | KARANGANYAR -> city KARANGANYAR, zip 57711
 *   JAWA TENGAH | KARANGANYAR | KARANGANYAR -> city KEBUMEN,     zip 54364
 * so it is used to gather CANDIDATES, and the postal code below decides.
 */
function nameKey(provinceName: string, districtName: string, subdistrictName: string): string {
  return [normalizeName(provinceName), normalizeName(districtName), normalizeName(subdistrictName)].join('|');
}

/** The full identity: the name key plus a NORMALISED, non-empty postal code. */
function fullKey(name: string, zip: string): string {
  return `${name}|${zip}`;
}

/**
 * Match each Massular village to exactly one RajaOngkir destination.
 *
 * No name-only match, no postal-only match, no fuzzy similarity, and never
 * "first result wins". Several candidates is a FAILURE to be reported, not a
 * choice to be made.
 *
 * `provinceAliases` maps a normalized Massular province name to its RajaOngkir
 * spelling (e.g. ACEH -> NANGGROE ACEH DARUSSALAM (NAD)). Curated, reviewed
 * data — not a normalisation rule — and empty by default.
 */
/**
 * PAXELBOX-60I: reviewed alias tables.
 *
 * An alias only changes which candidates a village GATHERS. Everything after
 * that is untouched: the postal code still decides between candidates, and
 * AMBIGUOUS still blocks. So an alias can never manufacture a match on its own
 * — if the postal evidence stops agreeing, the outcome degrades to
 * REVIEW_REQUIRED rather than binding a wrong destination.
 *
 * Village aliases are keyed DISTRICT|VILLAGE, never by village name alone,
 * because village names repeat across Indonesia.
 */
export interface MapAliases {
  province?: Record<string, string>;
  district?: Record<string, string>;
  village?: Record<string, string>;
}

/** Back-compat: a bare record is still read as province aliases. */
function toAliases(input: Record<string, string> | MapAliases): MapAliases {
  const values = Object.values(input);
  if (values.every((v) => typeof v === 'string')) return { province: input as Record<string, string> };
  return input as MapAliases;
}

function aliasIndex(table: Record<string, string> | undefined, keyed: boolean): Map<string, string> {
  const m = new Map<string, string>();
  for (const [from, to] of Object.entries(table ?? {})) {
    m.set(keyed ? from : normalizeName(from), normalizeName(to));
  }
  return m;
}

export function mapVillages(
  massular: MassularVillage[],
  rajaongkir: RajaOngkirDestination[],
  aliases: Record<string, string> | MapAliases = {},
): VillageMappingReport {
  const tables = toAliases(aliases);
  const aliased = aliasIndex(tables.province, false);
  const districtAliases = aliasIndex(tables.district, false);
  // Village keys arrive pre-normalised as `DISTRICT|VILLAGE`.
  const villageAliases = aliasIndex(tables.village, true);

  // Two indexes. The NAME index gathers candidates; the FULL index (name +
  // postal code) decides between them. A row whose postal code is unusable is
  // reachable only as a candidate, so it can never be silently selected.
  const byName = new Map<string, RajaOngkirDestination[]>();
  const byFull = new Map<string, RajaOngkirDestination[]>();
  for (const row of rajaongkir) {
    const name = nameKey(row.provinceName, row.districtName, row.subdistrictName);
    const nameBucket = byName.get(name);
    if (nameBucket) nameBucket.push(row);
    else byName.set(name, [row]);

    const zip = normalizeZip(row.zipCode);
    if (zip) {
      const full = fullKey(name, zip);
      const fullBucket = byFull.get(full);
      if (fullBucket) fullBucket.push(row);
      else byFull.set(full, [row]);
    }
  }

  const matches: VillageMatch[] = [];
  for (const v of massular) {
    const province = aliased.get(normalizeName(v.provinceName)) ?? normalizeName(v.provinceName);
    const district = districtAliases.get(normalizeName(v.districtName)) ?? normalizeName(v.districtName);
    const villageKey = `${normalizeName(v.districtName)}|${normalizeName(v.name)}`;
    const village = villageAliases.get(villageKey) ?? normalizeName(v.name);
    const name = nameKey(province, district, village);
    const candidates = byName.get(name) ?? [];
    const base = {
      code: v.code,
      provinceName: v.provinceName,
      cityName: v.cityName,
      districtName: v.districtName,
      villageName: v.name,
      // Everything the names alone brought back, so any refusal is reviewable.
      candidateIds: candidates.map((c) => c.id),
    };

    if (candidates.length === 0) {
      matches.push({ ...base, outcome: 'NOT_FOUND', reason: 'no RajaOngkir candidate for this hierarchy' });
      continue;
    }

    const ourZip = normalizeZip(v.postalCode);
    if (!ourZip) {
      // Postal code is part of IDENTITY now, so an absent one leaves identity
      // incomplete. Even a lone name candidate is not taken on names alone —
      // PAXELBOX-52B showed one name triple can belong to two different places.
      matches.push({
        ...base,
        outcome: 'REVIEW_REQUIRED',
        reason: 'massular postal code is missing, so identity cannot be completed',
      });
      continue;
    }

    const exact = byFull.get(fullKey(name, ourZip)) ?? [];

    if (exact.length === 1) {
      // Names AND postal code agree on exactly one destination. This is what
      // resolves the 52B collision: both rows share the names, one shares the zip.
      matches.push({ ...base, outcome: 'MATCHED', rajaOngkirId: exact[0].id });
      continue;
    }
    if (exact.length > 1) {
      // Same names, same postal code, several ids: the postal code has nothing
      // left to add, so this is a genuine tie and is never broken by picking one.
      matches.push({
        ...base,
        outcome: 'AMBIGUOUS',
        reason: 'multiple RajaOngkir candidates share this hierarchy and postal code',
      });
      continue;
    }

    // Names matched but no candidate agrees on the postal code. Not fatal —
    // RajaOngkir and Kemendagri maintain postal data separately — but never
    // accepted silently, and never resolved by falling back to the name match.
    if (candidates.some((c) => normalizeZip(c.zipCode) === null)) {
      matches.push({
        ...base,
        outcome: 'REVIEW_REQUIRED',
        reason: 'rajaongkir postal code is missing, so identity cannot be completed',
      });
      continue;
    }
    const theirZips = [...new Set(candidates.map((c) => normalizeZip(c.zipCode)))].join(', ');
    matches.push({
      ...base,
      outcome: 'REVIEW_REQUIRED',
      reason: `postal code differs (massular ${ourZip} vs rajaongkir ${theirZips})`,
    });
  }

  // One RajaOngkir id claimed by two villages means at least one is wrong.
  const idOwners = new Map<number, string[]>();
  for (const m of matches) {
    if (m.outcome !== 'MATCHED' || m.rajaOngkirId === undefined) continue;
    const owners = idOwners.get(m.rajaOngkirId);
    if (owners) owners.push(m.code);
    else idOwners.set(m.rajaOngkirId, [m.code]);
  }
  const duplicateIds = [...idOwners.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([id]) => id)
    .sort((a, b) => a - b);

  const count = (o: MatchOutcome) => matches.filter((m) => m.outcome === o).length;
  const ambiguous = count('AMBIGUOUS');

  // NOT_FOUND and REVIEW_REQUIRED are fine — those villages simply stay NULL and
  // yield no JNE quote. Ambiguity and duplication are NOT: both mean the data is
  // telling us something we do not understand yet, and writing either would put
  // a wrong price in front of a customer.
  const blockers: string[] = [];
  if (ambiguous > 0) blockers.push(`${ambiguous} village(s) matched more than one RajaOngkir destination`);
  if (duplicateIds.length > 0) blockers.push(`${duplicateIds.length} RajaOngkir id(s) claimed by multiple villages`);

  return {
    total: massular.length,
    matched: count('MATCHED'),
    ambiguous,
    notFound: count('NOT_FOUND'),
    reviewRequired: count('REVIEW_REQUIRED'),
    duplicateIds,
    matches,
    safeToApply: blockers.length === 0,
    blockers,
  };
}

/** The rows that may be written. Empty whenever the report is not safe to apply. */
export function applicableMappings(report: VillageMappingReport): Array<{ code: string; rajaOngkirId: number }> {
  if (!report.safeToApply) return [];
  return report.matches
    .filter((m): m is VillageMatch & { rajaOngkirId: number } => m.outcome === 'MATCHED' && m.rajaOngkirId !== undefined)
    .map((m) => ({ code: m.code, rajaOngkirId: m.rajaOngkirId }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

/** Human-readable sample for the review step. Never writes anything. */
export function formatSample(report: VillageMappingReport, limit = 20): string {
  const lines = [
    `total=${report.total} matched=${report.matched} ambiguous=${report.ambiguous} ` +
      `notFound=${report.notFound} reviewRequired=${report.reviewRequired}`,
    `duplicateIds=${report.duplicateIds.length} safeToApply=${report.safeToApply}`,
    '',
    'kemendagri        province / city / district / village              -> roId    outcome',
  ];
  for (const m of report.matches.slice(0, limit)) {
    const where = `${m.provinceName} / ${m.cityName} / ${m.districtName} / ${m.villageName}`;
    lines.push(
      `${m.code.padEnd(17)} ${where.padEnd(48).slice(0, 48)} -> ` +
        `${String(m.rajaOngkirId ?? '-').padEnd(8)} ${m.outcome}` +
        (m.reason ? ` (${m.reason})` : ''),
    );
  }
  return lines.join('\n');
}
