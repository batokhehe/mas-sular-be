/**
 * PAXELBOX-61F: resolve internal Districts against JNE destination master data.
 *
 * ---------------------------------------------------------------------------
 * THE INTERNAL DATABASE IS AUTHORITATIVE
 *
 * Resolution iterates over OUR districts and looks for a JNE row, never the
 * other way round. That ordering is the whole Kabupaten safeguard: JNE lists
 * `CILENGKRANG,BANDUNG` and `ARJASARI,BANDUNG` even though both are Kabupaten
 * Bandung districts, so a JNE-first walk would happily invent Kota Bandung
 * mappings for them. Iterating over our 30 districts means those rows are never
 * looked up at all.
 *
 * Administrative identity comes from District -> City -> City.type -> Province.
 * Never from a postal code, a RajaOngkir id, a JNE code prefix, or JNE's own
 * parent string — PAXELBOX-61C showed JNE's `KAB.` marker is inconsistent
 * (`KAB.BANDUNG`, `KAB MAJALENGKA`, and Kabupaten rows with no marker at all).
 *
 * ---------------------------------------------------------------------------
 * NOTHING IS EVER AUTO-APPROVED
 *
 * Every candidate this module produces is REVIEW_REQUIRED, including the exact
 * one-candidate matches and including the four reviewed aliases. Promotion to
 * MATCHED is a separate, explicit operator action.
 *
 * No I/O: no HTTP client, no filesystem, no Prisma. The caller supplies rows.
 */

import { normalizeJneName } from './jne-master';

export type JneMappingStatus = 'MATCHED' | 'REVIEW_REQUIRED' | 'AMBIGUOUS' | 'NOT_FOUND';
export type JneMappingMethod = 'EXACT_NAME' | 'REVIEWED_ALIAS' | 'MANUAL';

/** The internal side, exactly as the region models hold it. */
export interface InternalDistrict {
  id: string;
  name: string;
  cityId: string;
  cityName: string;
  cityType: 'CITY' | 'REGENCY';
  provinceId: string;
  provinceName: string;
}

/** The JNE side, as imported into JneLocation. */
export interface JneCandidateRow {
  id: string;
  code: string;
  rawName: string;
  parsedChild: string;
  parsedParent: string | null;
  kind: string;
  source: string;
  isActive: boolean;
}

/**
 * A reviewed district-name alias.
 *
 * Curated DATA, never a rule. `CICADAS` and `MARGACINTA` are the historic names
 * of Antapani and Buahbatu; `SUMURBANDUNG` and `BABAKANCIPARAY` are the
 * space-removed forms. No string transformation could derive the first two, and
 * inventing one would be exactly the fuzzy matching this programme has refused
 * throughout.
 */
export interface DistrictAlias {
  readonly kind?: 'CHILD';
  /** Internal District.name, exactly as stored. */
  district: string;
  /** Internal City.name that scopes the alias — never applied city-wide. */
  city: string;
  /** JNE's parsedChild to look for instead. */
  jneChild: string;
  rationale: string;
}

/**
 * PAXELBOX-61G: a reviewed alias for JNE's PARENT string.
 *
 * Separate from a child alias because it is a different risk. A child alias
 * renames one district; a parent alias widens which JNE rows an ENTIRE city is
 * allowed to draw from, so it is scoped to city AND province AND CITY-type, and
 * it names the exact parent string it accepts. There is deliberately no rule
 * that derives one — `BANDUG` is admitted because it was observed, counted and
 * reviewed, not because it looks like `BANDUNG`.
 */
export interface ParentAlias {
  readonly kind: 'PARENT';
  /** Internal City.name this alias is scoped to. */
  city: string;
  /** Internal Province.name this alias is scoped to. */
  province: string;
  /** The exact JNE parsedParent string to additionally accept. */
  jneParent: string;
  rationale: string;
}

/**
 * Reviewed parent aliases. EXACTLY ONE, and it stays that way unless another is
 * separately reviewed.
 *
 * Evidence gathered from the PAXELBOX-61C snapshot before approval:
 *   - `BANDUG` occurs as a parent on exactly 2 of 8,322 rows
 *   - it never occurs as a standalone place, and never as a child
 *   - both codes sit in the BDO10xxx Kota Bandung block
 *   - each affected child resolves to exactly one row
 *   - admitting it introduces 0 new ambiguity across all 30 districts
 */
export const KOTA_BANDUNG_PARENT_ALIASES: ParentAlias[] = [
  {
    kind: 'PARENT',
    city: 'Kota Bandung',
    province: 'Jawa Barat',
    jneParent: 'BANDUG',
    rationale:
      'JNE parent "BANDUG" is reviewed as a typo alias for internal Kota Bandung parent "BANDUNG". ' +
      'It affects exactly two rows (COBLONG,BANDUG = BDO10054 and BOJONGLOA KIDUL,BANDUG = BDO10050), ' +
      'both in the BDO10xxx Kota Bandung block, each resolving to exactly one candidate. ' +
      'No standalone BANDUG parent exists anywhere in the 61C snapshot. ' +
      'This is an explicit reviewed alias, NOT fuzzy matching: no edit distance, phonetic rule or ' +
      'generic typo correction is performed, and no other parent string is rewritten.',
  },
];

export const KOTA_BANDUNG_DISTRICT_ALIASES: DistrictAlias[] = [
  {
    district: 'Sumur Bandung',
    city: 'Kota Bandung',
    jneChild: 'SUMURBANDUNG',
    rationale:
      'JNE writes the name without the space. Independently corroborated by the reviewed RajaOngkir mapping approved in PAXELBOX-60H.',
  },
  {
    district: 'Babakan Ciparay',
    city: 'Kota Bandung',
    jneChild: 'BABAKANCIPARAY',
    rationale:
      'JNE writes the name without the space. Independently corroborated by the reviewed RajaOngkir mapping approved in PAXELBOX-60H.',
  },
  {
    district: 'Antapani',
    city: 'Kota Bandung',
    jneChild: 'CICADAS',
    rationale:
      'CICADAS is the historic name of Antapani. Independently corroborated by RajaOngkir, whose own row is ANTAPANI (CICADAS) and whose alias was approved in PAXELBOX-60H.',
  },
  {
    district: 'Buahbatu',
    city: 'Kota Bandung',
    jneChild: 'MARGACINTA',
    rationale:
      'MARGACINTA is the historic name of Buahbatu. Independently corroborated by RajaOngkir, whose own row is BUAHBATU (MARGACINTA) and whose alias was approved in PAXELBOX-60H.',
  },
];

/**
 * The JNE parent string that corresponds to an internal city.
 *
 * JNE drops the administrative prefix: our "Kota Bandung" is their "BANDUNG".
 * Only CITY is supported. A REGENCY would need JNE's `KAB.` form, which
 * PAXELBOX-61C measured as unreliable — inconsistent punctuation, truncated
 * abbreviations, and Kabupaten rows carrying no marker at all — so a regency is
 * refused rather than guessed at.
 */
export function jneParentForCity(cityName: string, cityType: 'CITY' | 'REGENCY'): string | null {
  if (cityType !== 'CITY') return null;
  const n = normalizeJneName(cityName);
  return n.replace(/^KOTA\s+/, '').trim() || null;
}

export interface MappingEvidence {
  internalDistrictId: string;
  internalDistrictName: string;
  internalCityId: string;
  internalCityName: string;
  internalCityType: string;
  internalProvinceId: string;
  internalProvinceName: string;
  jneLocationId: string | null;
  jneCode: string | null;
  jneRawName: string | null;
  jneParsedChild: string | null;
  jneParsedParent: string | null;
  candidateCount: number;
  candidateCodes: string[];
  matchingMethod: JneMappingMethod;
  aliasRationale: string | null;
  /** The parent our internal city maps to before any alias is considered. */
  expectedJneParent: string | null;
  /** Every parent string accepted for this district, including reviewed aliases. */
  acceptedJneParents: string[];
  /** Human-readable description of the alias applied, if any. */
  aliasTransformation: string | null;
  resolvedAt: string;
}

export interface MappingCandidate {
  district: InternalDistrict;
  status: JneMappingStatus;
  method: JneMappingMethod;
  jneLocationId: string | null;
  confidence: string | null;
  evidence: MappingEvidence;
  reason: string;
}

export interface ResolveOptions {
  aliases?: DistrictAlias[];
  parentAliases?: ParentAlias[];
  now?: () => string;
}

/**
 * Resolve one district.
 *
 * Eligibility is checked before any lookup: only an active, SANDBOX,
 * DESTINATION row under the expected parent can be a candidate. A candidate
 * count of exactly one yields REVIEW_REQUIRED; more than one yields AMBIGUOUS
 * and is NEVER resolved by taking the first; zero yields NOT_FOUND.
 */
export function resolveDistrictCandidate(
  district: InternalDistrict,
  rows: JneCandidateRow[],
  options: ResolveOptions = {},
): MappingCandidate {
  const aliases = options.aliases ?? KOTA_BANDUNG_DISTRICT_ALIASES;
  const parentAliases = options.parentAliases ?? KOTA_BANDUNG_PARENT_ALIASES;
  const resolvedAt = (options.now ?? (() => new Date().toISOString()))();

  const expectedParent = jneParentForCity(district.cityName, district.cityType);

  // A parent alias is scoped to city AND province AND CITY-type. All three must
  // agree before an extra parent string is admitted for this district.
  const applicableParentAliases =
    expectedParent === null
      ? []
      : parentAliases.filter(
          (a) =>
            district.cityType === 'CITY' &&
            normalizeJneName(a.city) === normalizeJneName(district.cityName) &&
            normalizeJneName(a.province) === normalizeJneName(district.provinceName),
        );
  const acceptedParents =
    expectedParent === null
      ? []
      : [expectedParent, ...applicableParentAliases.map((a) => normalizeJneName(a.jneParent))];

  const alias = aliases.find(
    (a) =>
      normalizeJneName(a.district) === normalizeJneName(district.name) &&
      normalizeJneName(a.city) === normalizeJneName(district.cityName),
  );
  const wantedChild = alias ? normalizeJneName(alias.jneChild) : normalizeJneName(district.name);

  const base = (
    candidates: JneCandidateRow[],
    chosen: JneCandidateRow | null,
    method: JneMappingMethod,
    transformation: string | null,
    parentAlias: ParentAlias | null,
  ): MappingEvidence => ({
    internalDistrictId: district.id,
    internalDistrictName: district.name,
    internalCityId: district.cityId,
    internalCityName: district.cityName,
    internalCityType: district.cityType,
    internalProvinceId: district.provinceId,
    internalProvinceName: district.provinceName,
    jneLocationId: chosen?.id ?? null,
    jneCode: chosen?.code ?? null,
    jneRawName: chosen?.rawName ?? null,
    jneParsedChild: chosen?.parsedChild ?? null,
    jneParsedParent: chosen?.parsedParent ?? null,
    candidateCount: candidates.length,
    candidateCodes: candidates.map((c) => c.code),
    matchingMethod: method,
    aliasRationale: alias?.rationale ?? parentAlias?.rationale ?? null,
    expectedJneParent: expectedParent,
    acceptedJneParents: acceptedParents,
    aliasTransformation: transformation,
    resolvedAt,
  });

  // A regency has no reliable JNE parent form, so it is refused before lookup.
  if (expectedParent === null) {
    return {
      district,
      status: 'NOT_FOUND',
      method: alias ? 'REVIEWED_ALIAS' : 'EXACT_NAME',
      jneLocationId: null,
      confidence: null,
      evidence: base([], null, alias ? 'REVIEWED_ALIAS' : 'EXACT_NAME', null, null),
      reason:
        `city "${district.cityName}" is ${district.cityType}; JNE's KAB. form is inconsistent (PAXELBOX-61C), so a regency is not resolved automatically`,
    };
  }

  // PARENT-AWARE by construction: a child-name-only lookup would bind
  // Kota Bandung's Lengkong to Nganjuk's. `acceptedParents` is the expected
  // parent plus any REVIEWED parent alias - never an arbitrary near-match.
  const candidates = rows.filter(
    (r) =>
      r.isActive &&
      r.kind === 'DESTINATION' &&
      r.source === 'SANDBOX' &&
      normalizeJneName(r.parsedChild) === wantedChild &&
      r.parsedParent !== null &&
      acceptedParents.includes(normalizeJneName(r.parsedParent)),
  );

  /** Which reviewed parent alias, if any, a given row was admitted by. */
  const parentAliasFor = (r: JneCandidateRow | null): ParentAlias | null => {
    if (!r || r.parsedParent === null) return null;
    const p = normalizeJneName(r.parsedParent);
    if (p === expectedParent) return null;
    return applicableParentAliases.find((a) => normalizeJneName(a.jneParent) === p) ?? null;
  };

  const methodFor = (r: JneCandidateRow | null): JneMappingMethod =>
    alias || parentAliasFor(r) ? 'REVIEWED_ALIAS' : 'EXACT_NAME';

  const transformationFor = (r: JneCandidateRow | null): string | null => {
    const pa = parentAliasFor(r);
    const parts: string[] = [];
    if (alias) parts.push(`child "${district.name}" -> "${alias.jneChild}"`);
    if (pa) parts.push(`parent "${pa.jneParent}" -> "${expectedParent}"`);
    return parts.length ? parts.join('; ') : null;
  };

  if (candidates.length === 0) {
    return {
      district,
      status: 'NOT_FOUND',
      method: methodFor(null),
      jneLocationId: null,
      confidence: null,
      evidence: base([], null, methodFor(null), transformationFor(null), null),
      reason: `no active JNE DESTINATION row with child "${wantedChild}" under parent(s) ${acceptedParents.map((p) => `"${p}"`).join(', ')}`,
    };
  }

  if (candidates.length > 1) {
    // Never break the tie. Two codes for one district is a routing question
    // (PAXELBOX-61C found 498 names spanning multiple hubs), not a naming one.
    return {
      district,
      status: 'AMBIGUOUS',
      method: methodFor(null),
      jneLocationId: null,
      confidence: null,
      evidence: base(candidates, null, methodFor(null), transformationFor(null), null),
      reason: `${candidates.length} JNE rows match; a tie is never resolved by picking one`,
    };
  }

  const chosen = candidates[0];
  const parentAlias = parentAliasFor(chosen);
  const method = methodFor(chosen);
  return {
    district,
    status: 'REVIEW_REQUIRED', // never MATCHED, however clean the match looks
    method,
    jneLocationId: chosen.id,
    // `confidence` is VarChar(32) and holds a bare grade; the sentence-length
    // rationale belongs in `notes` (TEXT) and in the evidence payload.
    confidence: 'HIGH',
    evidence: base(candidates, chosen, method, transformationFor(chosen), parentAlias),
    reason: parentAlias
      ? `reviewed PARENT alias "${parentAlias.jneParent}" -> "${expectedParent}" resolved to exactly one JNE row`
      : alias
        ? `reviewed alias "${alias.jneChild}" resolved to exactly one JNE row`
        : 'exact child+parent match with exactly one JNE row',
  };
}

export interface ResolveSummary {
  districts: number;
  candidates: MappingCandidate[];
  reviewRequired: number;
  ambiguous: number;
  notFound: number;
  matched: number;
  exactName: number;
  reviewedAlias: number;
}

/** Resolve every district. Deterministic: input order is preserved. */
export function resolveDistrictCandidates(
  districts: InternalDistrict[],
  rows: JneCandidateRow[],
  options: ResolveOptions = {},
): ResolveSummary {
  const candidates = districts.map((d) => resolveDistrictCandidate(d, rows, options));
  const count = (s: JneMappingStatus) => candidates.filter((c) => c.status === s).length;
  return {
    districts: districts.length,
    candidates,
    reviewRequired: count('REVIEW_REQUIRED'),
    ambiguous: count('AMBIGUOUS'),
    notFound: count('NOT_FOUND'),
    // Structurally zero: this module never emits MATCHED.
    matched: count('MATCHED'),
    exactName: candidates.filter((c) => c.method === 'EXACT_NAME').length,
    reviewedAlias: candidates.filter((c) => c.method === 'REVIEWED_ALIAS').length,
  };
}


// ------------------------------------------- approval (PAXELBOX-61H)

/**
 * Whether a mapping row may be promoted to MATCHED.
 *
 * Only REVIEW_REQUIRED is promotable. AMBIGUOUS has more than one candidate, so
 * approving it would mean picking one — the exact thing the resolver refuses to
 * do. NOT_FOUND has no candidate at all, so approving it would mean inventing
 * one. An already-MATCHED row is a no-op rather than an error, which is what
 * makes re-running an approval idempotent.
 */
export function approvalDecision(status: JneMappingStatus): {
  promotable: boolean;
  alreadyApproved: boolean;
  reason: string;
} {
  switch (status) {
    case 'REVIEW_REQUIRED':
      return { promotable: true, alreadyApproved: false, reason: 'reviewed candidate awaiting approval' };
    case 'MATCHED':
      return { promotable: false, alreadyApproved: true, reason: 'already approved; nothing to do' };
    case 'AMBIGUOUS':
      return {
        promotable: false,
        alreadyApproved: false,
        reason: 'AMBIGUOUS has more than one candidate; approving it would mean choosing one',
      };
    case 'NOT_FOUND':
      return {
        promotable: false,
        alreadyApproved: false,
        reason: 'NOT_FOUND has no candidate; approving it would mean inventing one',
      };
  }
}
