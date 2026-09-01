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

export type PlanStrategy = 'SINGLE_TOKEN_DISTRICT' | 'REVIEWED_ALIAS' | 'REVIEW_REQUIRED';

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
  /** Always UNKNOWN: no total-count metadata exists, so real cost is unprovable. */
  totalPlannedRequests: 'UNKNOWN';
  /** The only figure the plan can prove: units x ceiling. */
  worstCaseRequests: number;
}

export interface SearchPlanOptions {
  limit?: number;
  maxPages?: number;
  baseUrl?: string;
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

  const units = all.filter((u) => !u.requiresReview);
  return {
    units,
    review: all.filter((u) => u.requiresReview),
    all,
    limit,
    maxPages,
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
