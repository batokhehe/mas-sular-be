/**
 * PAXELBOX-58: the acquisition plan for the approved scope.
 *
 * ---------------------------------------------------------------------------
 * THE APPROVED SCOPE, RECORDED IN THE REPOSITORY
 *
 * PAXELBOX-57 flagged that the approved scope existed only in conversation.
 * It is written down here so the plan is derived from a committed artifact
 * rather than recalled:
 *
 *     ALL MASSULAR VILLAGES WITHIN KOTA BANDUNG, JAWA BARAT
 *     measured 2026-09-01: 151 villages across 30 districts
 *
 * ---------------------------------------------------------------------------
 * PURE BY CONSTRUCTION
 *
 * This module has no database access and no HTTP client: it takes the village
 * records as an argument. That keeps the runner free of Prisma (PAXELBOX-57
 * Part 6) and makes the plan reproducible from a fixture in a test.
 */

import type { PaginatedAcquisitionUnit } from './rajaongkir-acquisition';
import { destinationUrl, RAJAONGKIR_BASE_URL } from './rajaongkir-transport';
import { normalizeName, type MassularVillage } from './rajaongkir-village-map';

/** The approved scope, as a value the plan builder can be checked against. */
export const APPROVED_SCOPE = {
  provinceName: 'Jawa Barat',
  cityName: 'Kota Bandung',
  expectedVillages: 151,
  expectedDistricts: 30,
  measuredOn: '2026-09-01',
} as const;

/**
 * Page size. 20 is the value the endpoint was observed to honour exactly
 * (PAXELBOX-56B: limit=2 returned 2 of a known 4). Kept modest deliberately —
 * the daily quota is still unmeasured, and a larger page buys little when the
 * largest Kota Bandung district holds 8 villages.
 */
export const DEFAULT_PAGE_LIMIT = 20;

/**
 * The page ceiling the plan assumes. Deliberately IDENTICAL to the runner's
 * DEFAULT_MAX_PAGES - the planner does not get to raise the runner's safety
 * limit. Lowering it would waste less budget on a runaway term, but that is a
 * runner decision and is left alone here.
 */
export const SEARCH_PLAN_MAX_PAGES = 20;

export type SearchStrategy = 'district' | 'village';

export interface PlanOptions {
  strategy?: SearchStrategy;
  limit?: number;
  baseUrl?: string;
}

export class EmptySearchTermError extends Error {
  constructor(context: string) {
    super(`refusing to build a unit with a blank search term (${context})`);
    this.name = 'EmptySearchTermError';
  }
}

export interface AcquisitionPlan {
  units: PaginatedAcquisitionUnit[];
  strategy: SearchStrategy;
  limit: number;
  /** Villages the plan intends to resolve. Never fewer than the input. */
  villageCount: number;
  districtCount: number;
}

/** Stable, traversal-safe unit key component. */
function slug(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Build the plan.
 *
 * DISTRICT is the default. PAXELBOX-56 proved `search=<district name>` returns
 * the district's village-level rows (Gedebage → 4 rows, all `district_name`
 * GEDEBAGE), which costs 30 requests instead of 151 against a quota nobody has
 * measured. VILLAGE remains available for districts that come back inconclusive.
 *
 * Neither strategy assumes 1 village = 1 row, 1 search = 1 result, or
 * 1 search = 1 request: the runner pages every unit to exhaustion, and the
 * MATCHER — not the plan — decides which returned row is the right one. A
 * search for "Gedebage" legitimately returns rows from other provinces; that is
 * expected, and they are simply candidates the matcher discards.
 */
export function buildAcquisitionPlan(villages: MassularVillage[], options: PlanOptions = {}): AcquisitionPlan {
  const strategy = options.strategy ?? 'district';
  const limit = options.limit ?? DEFAULT_PAGE_LIMIT;
  const baseUrl = options.baseUrl ?? RAJAONGKIR_BASE_URL;

  const districts = new Set(villages.map((v) => v.districtName));

  // Deduplicate search terms, then sort, so the same input always yields the
  // same plan in the same order — a resumed run must line up with the
  // checkpoint written by the previous one.
  const terms =
    strategy === 'district'
      ? [...new Set(villages.map((v) => v.districtName))]
      : [...new Set(villages.map((v) => v.name))];
  terms.sort((a, b) => a.localeCompare(b, 'en'));

  const units: PaginatedAcquisitionUnit[] = terms.map((term) => {
    const searchTerm = term.trim();
    // A blank search is rejected by the API with 422 (PAXELBOX-52E). Catching
    // it here means a bad data row cannot spend a request to discover that.
    if (!searchTerm) throw new EmptySearchTermError(`${strategy} term`);
    return {
      key: `${strategy}-${slug(searchTerm)}`,
      searchTerm,
      limit,
      urlFor: (offset: number) => destinationUrl(searchTerm, limit, offset, baseUrl),
    };
  });

  return { units, strategy, limit, villageCount: villages.length, districtCount: districts.size };
}

/**
 * Guard the plan against the approved scope before anything is spent.
 *
 * Returns the reasons a plan does NOT match the approval, so an operator sees
 * every problem at once. An empty array means the plan is in scope.
 */
export function scopeViolations(villages: MassularVillage[]): string[] {
  const problems: string[] = [];

  const provinces = [...new Set(villages.map((v) => v.provinceName))];
  const cities = [...new Set(villages.map((v) => v.cityName))];
  const districts = new Set(villages.map((v) => v.districtName));

  if (provinces.length !== 1 || provinces[0] !== APPROVED_SCOPE.provinceName) {
    problems.push(`province must be exactly [${APPROVED_SCOPE.provinceName}], got [${provinces.join(', ')}]`);
  }
  if (cities.length !== 1 || cities[0] !== APPROVED_SCOPE.cityName) {
    problems.push(`city must be exactly [${APPROVED_SCOPE.cityName}], got [${cities.join(', ')}]`);
  }
  if (villages.length !== APPROVED_SCOPE.expectedVillages) {
    problems.push(`expected ${APPROVED_SCOPE.expectedVillages} villages, got ${villages.length}`);
  }
  if (districts.size !== APPROVED_SCOPE.expectedDistricts) {
    problems.push(`expected ${APPROVED_SCOPE.expectedDistricts} districts, got ${districts.size}`);
  }

  const duplicateCodes = villages
    .map((v) => v.code)
    .filter((code, i, all) => all.indexOf(code) !== i);
  if (duplicateCodes.length > 0) {
    problems.push(`duplicate village codes: ${[...new Set(duplicateCodes)].join(', ')}`);
  }

  return problems;
}

// ------------------------------------------ search plan (PAXELBOX-60E)

/**
 * PAXELBOX-60E: a REVIEWABLE search plan, built before anything is spent.
 *
 * ---------------------------------------------------------------------------
 * WHY buildAcquisitionPlan IS NOT ENOUGH
 *
 * It uses the Massular district name verbatim as the search term. PAXELBOX-60D
 * proved that does not scale, because RajaOngkir's `search` is TOKEN-OR, not a
 * phrase match:
 *
 *   "Andir"            -> 1 page,   9 rows   (usable)
 *   "Babakan Ciparay"  -> 5 pages, 96 rows across 53 districts; only 6 ours
 *   "Bandung Kidul"    -> 20 full pages, ceiling hit, set never proven complete
 *
 * ---------------------------------------------------------------------------
 * THE ONE BOUNDED CLASS WE CAN ACTUALLY EVIDENCE
 *
 * Every SINGLE-TOKEN search we have ever issued finished inside one page:
 * Andir 9, Antapani 4, Arcamanik 5, Gedebage 4 rows, and Astanaanyar 0 (404).
 * Five observations, no counter-example. That is the only class this planner
 * will emit.
 *
 * It deliberately does NOT try to pick "the distinctive token" out of a
 * multi-word name, because the one measurement we have says that reasoning is
 * unsound: inside the "Babakan Ciparay" result, "BABAKAN" appears in 79 of 96
 * rows - the token is BROADER than the phrase. Choosing a token without having
 * searched it is a guess, and a guess here costs a whole day of quota. Those
 * districts become REVIEW_REQUIRED instead.
 */

/** Terms too generic to be safe, regardless of how a name is spelled. */
export const GENERIC_TOKENS = [
  'BANDUNG', 'KOTA', 'KABUPATEN', 'KAB', 'KEC', 'KECAMATAN', 'DESA', 'KELURAHAN',
  'KULON', 'WETAN', 'KIDUL', 'KALER', 'UTARA', 'SELATAN', 'TIMUR', 'BARAT', 'TENGAH',
] as const;

// ------------------------------------- VILLAGE_TOKEN (PAXELBOX-60L)

/**
 * PAXELBOX-60L: a village-name search term that has been MEASURED.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A LIST OF MEASUREMENTS AND NOT A RULE
 *
 * PAXELBOX-60K searched "Braga" and got one row back. It would be very easy to
 * read that as "village names are safe search terms" — and wrong. Braga is an
 * unusually favourable case: exactly one place in Indonesia carries the name.
 * The same repository already contains the counter-examples, from searches we
 * actually ran: "Sukajadi" returned 57 rows over 3 pages, and inside the
 * "Babakan Ciparay" result the token BABAKAN appeared in 79 of 96 rows. Names
 * like Merdeka, Sukamaju, Neglasari and Cicadas are common, and two of those
 * are already known to collide with places outside Bandung.
 *
 * So a term earns EXECUTABLE only by having been searched, with the row and
 * page counts recorded here. One measurement promotes one term — never a class.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT DO
 *
 * A village token resolves the VILLAGE it names, not the district around it.
 * Sumur Bandung's other open villages (Merdeka, Kebon Pisang) are untouched by
 * the Braga entry, and its district stays REVIEW_REQUIRED for exactly that
 * reason.
 */
export interface VillageTokenEvidence {
  /** The exact term searched. */
  searchTerm: string;
  /** Massular district the term targets. */
  massularDistrict: string;
  /** Massular village(s) the measurement resolved. */
  massularVillages: string[];
  /** Measured: rows returned, pages walked, and the limit they were measured at. */
  measuredRows: number;
  measuredPages: number;
  measuredLimit: number;
  /** Destination id(s) the measurement identified. */
  destinationIds: number[];
  /** Postal code(s) both sides agreed on. */
  postalCodes: string[];
  rajaOngkirDistrict: string;
  rajaOngkirVillage: string;
  /** The phase that performed the measurement. */
  evidenceSource: string;
}

/**
 * Measured village tokens. EXACTLY ONE entry — everything else stays review-only.
 */
export const VALIDATED_VILLAGE_TOKENS: VillageTokenEvidence[] = [
  {
    searchTerm: 'Braga',
    massularDistrict: 'Sumur Bandung',
    massularVillages: ['Braga'],
    measuredRows: 1,
    measuredPages: 1,
    measuredLimit: 20,
    destinationIds: [4949],
    postalCodes: ['40111'],
    rajaOngkirDistrict: 'SUMUR BANDUNG',
    rajaOngkirVillage: 'BRAGA',
    evidenceSource: 'PAXELBOX-60K',
  },
];

/**
 * Why a measurement is or is not sufficient to execute.
 *
 * `measuredRows < measuredLimit` is the load-bearing clause: it is the same
 * short-page rule the runner uses, and it is the only evidence that a result
 * set actually terminated. A measurement that filled its page proves nothing.
 */
export function villageTokenProblems(e: VillageTokenEvidence): string[] {
  const problems: string[] = [];
  if (!e.searchTerm.trim()) problems.push('search term is blank');
  if (!e.massularDistrict.trim()) problems.push('no target district');
  if (e.massularVillages.length === 0) problems.push('no target village');
  if (e.destinationIds.length === 0) problems.push('no destination id was identified');
  if (e.postalCodes.length === 0) problems.push('no postal agreement recorded');
  if (!e.rajaOngkirDistrict.trim() || !e.rajaOngkirVillage.trim()) problems.push('measurement does not name the RajaOngkir row');
  if (!e.evidenceSource.trim()) problems.push('no evidence source');
  if (e.measuredLimit <= 0 || e.measuredPages <= 0) problems.push('measurement is incomplete');
  else if (e.measuredRows >= e.measuredLimit) {
    problems.push(`measured ${e.measuredRows} rows at limit ${e.measuredLimit}: the page was full, so the result set was never proven bounded`);
  }
  return problems;
}

export type PlanStrategy = 'SINGLE_TOKEN_DISTRICT' | 'REVIEWED_ALIAS' | 'VILLAGE_TOKEN' | 'REVIEW_REQUIRED';

/** How a unit is allowed to be declared finished. Never "one page came back". */
export type CompletionCondition = 'SHORT_PAGE' | 'EMPTY_404' | 'PAGE_CEILING' | 'REVIEW_REQUIRED';

export type PlanRisk = 'LOW' | 'UNKNOWN';

export interface PlannedSearchUnit {
  unitId: string;
  massularDistrict: string;
  /** null whenever the district is REVIEW_REQUIRED - there is no safe term. */
  searchTerm: string | null;
  strategy: PlanStrategy;
  limit: number;
  maxPages: number;
  expectedCompletion: CompletionCondition[];
  /** Never estimated. UNKNOWN unless the plan itself bounds it. */
  expectedPages: 'UNKNOWN';
  risk: PlanRisk;
  reason: string;
  knownEvidence?: string;
  requiresReview: boolean;
  villages: number;
  /** VILLAGE_TOKEN units only: the measurement that made this term executable. */
  evidence?: VillageTokenEvidence;
  /** VILLAGE_TOKEN units only: the Massular villages this term is known to resolve. */
  targetVillages?: string[];
  /**
   * A PROPOSAL only, never executed by this plan. Present when every village in
   * a REVIEW_REQUIRED district has a single-token name, so a village-level run
   * would at least stay inside the evidenced class. Still needs one measured
   * search before anyone trusts it.
   */
  fallback?: { strategy: 'VILLAGE_TOKEN'; terms: string[]; requiresReview: true };
}

export interface SearchPlan {
  /** Units safe to execute. */
  units: PlannedSearchUnit[];
  /** Units that must not be executed until a human decides. */
  review: PlannedSearchUnit[];
  /** Every district, always. Nothing is ever dropped. */
  all: PlannedSearchUnit[];
  limit: number;
  maxPages: number;
  /** Districts represented. Always every district in the input — never fewer. */
  districts: number;
  /** Executable VILLAGE_TOKEN units, a subset of `units`. */
  villageTokenUnits: PlannedSearchUnit[];
  /** Always UNKNOWN: no total-count metadata exists, so real cost is unprovable. */
  totalPlannedRequests: 'UNKNOWN';
  /** The only figure the plan can prove: units x ceiling. */
  worstCaseRequests: number;
}

export interface SearchPlanOptions {
  limit?: number;
  maxPages?: number;
  baseUrl?: string;
  /** Overridden only by tests; production uses VALIDATED_VILLAGE_TOKENS. */
  villageTokens?: VillageTokenEvidence[];
  /**
   * Massular district name -> reviewed RajaOngkir spelling. EMPTY by default.
   * This planner never authors an entry; it only consumes ones a human wrote.
   */
  reviewedAliases?: Record<string, string>;
}

function tokens(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

export function isGenericToken(term: string): boolean {
  return (GENERIC_TOKENS as readonly string[]).includes(normalizeName(term));
}

const SINGLE_TOKEN_EVIDENCE =
  'PAXELBOX-56/59/60D: single-token searches Andir(9), Antapani(4), Arcamanik(5), Gedebage(4), Astanaanyar(0/404) each completed in one page';

/**
 * Build the reviewable plan. Pure: no network, no filesystem, no database.
 * Deterministic - districts are sorted, so the same input always yields the
 * same plan in the same order.
 */
export function buildSearchPlan(villages: MassularVillage[], options: SearchPlanOptions = {}): SearchPlan {
  const limit = options.limit ?? DEFAULT_PAGE_LIMIT;
  const maxPages = options.maxPages ?? SEARCH_PLAN_MAX_PAGES;
  const aliases = options.reviewedAliases ?? {};

  const districts = [...new Set(villages.map((v) => v.districtName))].sort((a, b) => a.localeCompare(b, 'en'));

  const all: PlannedSearchUnit[] = districts.map((district) => {
    const villageNames = villages.filter((v) => v.districtName === district).map((v) => v.name);
    const base = {
      unitId: `district-${slug(district)}`,
      massularDistrict: district,
      limit,
      maxPages,
      expectedPages: 'UNKNOWN' as const,
      villages: villageNames.length,
    };

    const review = (reason: string): PlannedSearchUnit => {
      const allSingle = villageNames.length > 0 && villageNames.every((n) => tokens(n).length === 1);
      return {
        ...base,
        searchTerm: null,
        strategy: 'REVIEW_REQUIRED',
        expectedCompletion: ['REVIEW_REQUIRED'],
        risk: 'UNKNOWN',
        reason,
        requiresReview: true,
        ...(allSingle
          ? {
              fallback: {
                strategy: 'VILLAGE_TOKEN' as const,
                terms: [...villageNames].sort((a, b) => a.localeCompare(b, 'en')),
                requiresReview: true as const,
              },
            }
          : {}),
      };
    };

    const executable = (term: string, strategy: PlanStrategy, reason: string): PlannedSearchUnit => ({
      ...base,
      searchTerm: term,
      strategy,
      // A run may legitimately end three ways; PAGE_CEILING is a FAILURE, listed
      // so nobody reads "it returned something" as "it is complete".
      expectedCompletion: ['SHORT_PAGE', 'EMPTY_404', 'PAGE_CEILING'],
      risk: 'LOW',
      reason,
      knownEvidence: SINGLE_TOKEN_EVIDENCE,
      requiresReview: false,
    });

    const alias = aliases[district];
    if (alias !== undefined) {
      const term = alias.trim();
      if (!term) throw new EmptySearchTermError(`reviewed alias for "${district}"`);
      return executable(term, 'REVIEWED_ALIAS', 'a human-reviewed RajaOngkir spelling was supplied for this district');
    }

    const name = district.trim();
    if (!name) throw new EmptySearchTermError('district name');

    if (tokens(name).length > 1) {
      return review(
        'multi-token district name: RajaOngkir search is token-OR, so this returns unrelated districts and may never terminate ' +
          '(PAXELBOX-60D: "Bandung Kidul" hit the page ceiling; "Babakan Ciparay" took 5 pages for 6 useful rows). ' +
          'No single token can be assumed bounded - inside that result "BABAKAN" appeared in 79 of 96 rows.',
      );
    }
    if (isGenericToken(name)) {
      return review(`"${name}" is a generic administrative token and would match far beyond this district`);
    }

    return executable(name, 'SINGLE_TOKEN_DISTRICT', 'district name is a single, non-generic token');
  });

  // VILLAGE_TOKEN units are ADDITIVE. They never replace a district unit, and a
  // district stays REVIEW_REQUIRED even when one of its villages has a measured
  // token — the token resolves that village, not the district around it.
  const villageTokenUnits: PlannedSearchUnit[] = [];
  const districtNames = new Set(districts.map((d) => normalizeName(d)));
  for (const e of options.villageTokens ?? VALIDATED_VILLAGE_TOKENS) {
    // Only plan tokens whose district is actually in this scope.
    if (!districtNames.has(normalizeName(e.massularDistrict))) continue;

    const problems = villageTokenProblems(e);
    const base = {
      unitId: `village-${slug(e.searchTerm)}`,
      massularDistrict: e.massularDistrict,
      limit,
      maxPages,
      expectedPages: 'UNKNOWN' as const,
      villages: e.massularVillages.length,
      targetVillages: [...e.massularVillages],
      evidence: e,
    };

    if (problems.length > 0) {
      villageTokenUnits.push({
        ...base,
        searchTerm: null,
        strategy: 'REVIEW_REQUIRED',
        expectedCompletion: ['REVIEW_REQUIRED'],
        risk: 'UNKNOWN',
        reason: `village token "${e.searchTerm}" is not executable: ${problems.join('; ')}`,
        requiresReview: true,
      });
      continue;
    }

    villageTokenUnits.push({
      ...base,
      searchTerm: e.searchTerm,
      strategy: 'VILLAGE_TOKEN',
      expectedCompletion: ['SHORT_PAGE', 'EMPTY_404', 'PAGE_CEILING'],
      risk: 'LOW',
      reason: `measured in ${e.evidenceSource}: ${e.measuredRows} row(s) over ${e.measuredPages} page(s) at limit ${e.measuredLimit}`,
      knownEvidence:
        `${e.evidenceSource}: "${e.searchTerm}" -> ${e.rajaOngkirDistrict} | ${e.rajaOngkirVillage} ` +
        `id ${e.destinationIds.join(',')} postal ${e.postalCodes.join(',')}`,
      requiresReview: false,
    });
  }

  const everything = [...all, ...villageTokenUnits];
  const units = everything.filter((u) => !u.requiresReview);
  return {
    units,
    review: everything.filter((u) => u.requiresReview),
    all: everything,
    limit,
    maxPages,
    districts: districts.length,
    villageTokenUnits: villageTokenUnits.filter((u) => !u.requiresReview),
    totalPlannedRequests: 'UNKNOWN',
    worstCaseRequests: units.length * maxPages,
  };
}

/** Turn reviewable units into runnable ones. REVIEW_REQUIRED units are refused. */
export function toAcquisitionUnits(
  plan: SearchPlan,
  baseUrl: string = RAJAONGKIR_BASE_URL,
): PaginatedAcquisitionUnit[] {
  return plan.units.map((u) => {
    if (!u.searchTerm) throw new EmptySearchTermError(u.unitId);
    const term = u.searchTerm;
    return {
      key: u.unitId,
      searchTerm: term,
      limit: u.limit,
      urlFor: (offset: number) => destinationUrl(term, u.limit, offset, baseUrl),
    };
  });
}
