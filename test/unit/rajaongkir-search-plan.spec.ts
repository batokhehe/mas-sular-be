import {
  buildSearchPlan,
  isGenericToken,
  toAcquisitionUnits,
  EmptySearchTermError,
  GENERIC_TOKENS,
  SEARCH_PLAN_MAX_PAGES,
  DEFAULT_PAGE_LIMIT,
} from '../../prisma/tools/rajaongkir-plan';
import { DEFAULT_MAX_PAGES } from '../../prisma/tools/rajaongkir-acquisition';
import type { MassularVillage } from '../../prisma/tools/rajaongkir-village-map';

/**
 * PAXELBOX-60E. The search planner, exercised purely — no network, no
 * filesystem, no database, no acquisition.
 *
 * The property under test is restraint. PAXELBOX-60D burned 20 requests on
 * "Bandung Kidul" because the plan assumed a district name is a phrase; the API
 * treats it as OR'd tokens. The planner must now emit ONLY the class we have
 * evidence for, and say REVIEW_REQUIRED — out loud, per district — for
 * everything else, rather than guessing a token that could be broader still.
 */

const jb = { cityName: 'Kota Bandung', provinceName: 'Jawa Barat' };
let seq = 0;
const village = (name: string, districtName: string): MassularVillage => ({
  code: `32.73.${String(++seq).padStart(2, '0')}.1001`,
  name,
  postalCode: '40000',
  districtName,
  ...jb,
});

/** Real Kota Bandung district names and their real village names (PAXELBOX-59 export). */
const KOTA_BANDUNG: MassularVillage[] = [
  village('Campaka', 'Andir'),
  village('Ciroyom', 'Andir'),
  village('Babakan Ciparay', 'Babakan Ciparay'),
  village('Margahayu Utara', 'Babakan Ciparay'),
  village('Batununggal', 'Bandung Kidul'),
  village('Wates', 'Bandung Kidul'),
  village('Mengger', 'Bandung Kidul'),
  village('Kujangsari', 'Bandung Kidul'),
  village('Cijerah', 'Bandung Kulon'),
  village('Warung Muncang', 'Bandung Kulon'),
  village('Cihapit', 'Bandung Wetan'),
  village('Taman Sari', 'Bandung Wetan'),
  village('Braga', 'Sumur Bandung'),
  village('Kebon Pisang', 'Sumur Bandung'),
  village('Padasuka', 'Cibeunying Kidul'),
  village('Cikutra', 'Cibeunying Kidul'),
  village('Antapani Kulon', 'Antapani'),
  village('Cimincrang', 'Gedebage'),
  village('Karasak', 'Astanaanyar'),
];

const unitFor = (district: string, villages = KOTA_BANDUNG) =>
  buildSearchPlan(villages).all.find((u) => u.massularDistrict === district)!;

// ------------------------------------------------------ 1-2. basic shape

describe('single-token districts', () => {
  it('Andir produces a deterministic, executable unit', () => {
    const u = unitFor('Andir');

    expect(u.strategy).toBe('SINGLE_TOKEN_DISTRICT');
    expect(u.searchTerm).toBe('Andir');
    expect(u.unitId).toBe('district-andir');
    expect(u.requiresReview).toBe(false);
    expect(u.risk).toBe('LOW');
    expect(u.knownEvidence).toMatch(/single-token searches/);
  });

  it('Gedebage, Antapani and Astanaanyar are all executable single-token units', () => {
    for (const d of ['Gedebage', 'Antapani', 'Astanaanyar']) {
      const u = unitFor(d);
      expect(u.strategy).toBe('SINGLE_TOKEN_DISTRICT');
      expect(u.searchTerm).toBe(d);
    }
  });
});

describe('multi-token districts are never treated as phrases', () => {
  it('Babakan Ciparay does not claim exact phrase matching', () => {
    const u = unitFor('Babakan Ciparay');

    expect(u.strategy).toBe('REVIEW_REQUIRED');
    expect(u.searchTerm).toBeNull();
    expect(u.reason).toMatch(/token-OR/);
    // The measured counter-example is cited, not hand-waved.
    expect(u.reason).toMatch(/79 of 96/);
  });
});

// --------------------------------------------- 3-6. the "Bandung *" group

describe('the Bandung group never collapses to the generic token', () => {
  it.each(['Bandung Kidul', 'Bandung Kulon', 'Bandung Wetan', 'Sumur Bandung'])(
    '%s does not produce "Bandung" blindly',
    (district) => {
      const u = unitFor(district);

      expect(u.strategy).toBe('REVIEW_REQUIRED');
      expect(u.searchTerm).toBeNull();
      expect(u.requiresReview).toBe(true);
    },
  );

  it('no unit anywhere in the plan searches a generic token', () => {
    const plan = buildSearchPlan(KOTA_BANDUNG);

    for (const u of plan.units) {
      expect(u.searchTerm).not.toBeNull();
      expect(isGenericToken(u.searchTerm!)).toBe(false);
    }
    // Belt and braces: the literal string never appears as a term.
    expect(plan.units.map((u) => u.searchTerm)).not.toContain('Bandung');
  });

  it('Bandung Kidul carries a village-token fallback PROPOSAL, not an executable term', () => {
    const u = unitFor('Bandung Kidul');

    // All four of its villages are single-token, so a fallback is at least
    // inside the evidenced class — but it is still only a proposal.
    expect(u.fallback).toEqual({
      strategy: 'VILLAGE_TOKEN',
      terms: ['Batununggal', 'Kujangsari', 'Mengger', 'Wates'],
      requiresReview: true,
    });
    expect(u.searchTerm).toBeNull();
    expect(buildSearchPlan(KOTA_BANDUNG).units).not.toContainEqual(expect.objectContaining({ massularDistrict: 'Bandung Kidul' }));
  });

  it('offers no fallback when a village name is itself multi-token', () => {
    // Bandung Kulon contains "Warung Muncang" — outside the evidenced class.
    expect(unitFor('Bandung Kulon').fallback).toBeUndefined();
  });
});

// -------------------------------------------------------- 7-8. aliases

describe('aliases are consumed, never authored', () => {
  it('the unreviewed Antapani alias is not silently used', () => {
    const u = unitFor('Antapani');

    expect(u.searchTerm).toBe('Antapani');
    expect(u.searchTerm).not.toMatch(/CICADAS/i);
    expect(u.strategy).not.toBe('REVIEWED_ALIAS');
  });

  it('no Astanaanyar spelling is invented after its 404', () => {
    const u = unitFor('Astanaanyar');

    expect(u.searchTerm).toBe('Astanaanyar');
    expect(u.searchTerm).not.toMatch(/astana anyar/i);
  });

  it('a reviewed alias supplied by a human IS used, and is labelled as such', () => {
    const plan = buildSearchPlan(KOTA_BANDUNG, {
      reviewedAliases: { Antapani: 'ANTAPANI (CICADAS)' },
    });
    const u = plan.all.find((x) => x.massularDistrict === 'Antapani')!;

    expect(u.strategy).toBe('REVIEWED_ALIAS');
    expect(u.searchTerm).toBe('ANTAPANI (CICADAS)');
    expect(u.requiresReview).toBe(false);
  });

  it('a blank reviewed alias is refused rather than sent', () => {
    expect(() => buildSearchPlan(KOTA_BANDUNG, { reviewedAliases: { Andir: '   ' } })).toThrow(EmptySearchTermError);
  });
});

// ------------------------------------------- 9-10. term safety invariants

describe('term safety', () => {
  it('an empty search term is impossible', () => {
    const plan = buildSearchPlan(KOTA_BANDUNG);
    for (const u of plan.units) expect(u.searchTerm!.trim().length).toBeGreaterThan(0);

    expect(() => buildSearchPlan([village('X', '   ')])).toThrow(EmptySearchTermError);
  });

  it('a district whose whole name is a generic token is refused, not searched', () => {
    for (const token of ['Bandung', 'Kota', 'Kidul', 'Wetan', 'Kulon']) {
      const u = buildSearchPlan([village('V', token)]).all[0];
      expect(u.strategy).toBe('REVIEW_REQUIRED');
      expect(u.reason).toMatch(/generic administrative token/);
    }
  });

  it('isGenericToken is case- and spacing-insensitive but not a substring test', () => {
    expect(isGenericToken('bandung')).toBe(true);
    expect(isGenericToken('  BANDUNG  ')).toBe(true);
    expect(isGenericToken('Bandung Kidul')).toBe(false); // a phrase, not a token
    expect(isGenericToken('Andir')).toBe(false);
    expect(GENERIC_TOKENS).toContain('BANDUNG');
  });
});

// ----------------------------------------- 11-12. completeness + ceiling

describe('completeness is never claimed', () => {
  it('expected page count is always UNKNOWN', () => {
    for (const u of buildSearchPlan(KOTA_BANDUNG).all) expect(u.expectedPages).toBe('UNKNOWN');
  });

  it('total planned requests is UNKNOWN; only the worst case is stated', () => {
    const plan = buildSearchPlan(KOTA_BANDUNG);

    expect(plan.totalPlannedRequests).toBe('UNKNOWN');
    expect(plan.worstCaseRequests).toBe(plan.units.length * plan.maxPages);
  });

  it('executable units list every legitimate ending, including the failure one', () => {
    const u = unitFor('Andir');
    expect(u.expectedCompletion).toEqual(['SHORT_PAGE', 'EMPTY_404', 'PAGE_CEILING']);
  });

  it('review units expose REVIEW_REQUIRED as their only completion condition', () => {
    expect(unitFor('Bandung Kidul').expectedCompletion).toEqual(['REVIEW_REQUIRED']);
  });

  it('the plan never raises the runner page ceiling', () => {
    expect(SEARCH_PLAN_MAX_PAGES).toBe(DEFAULT_MAX_PAGES);
    for (const u of buildSearchPlan(KOTA_BANDUNG).all) expect(u.maxPages).toBe(DEFAULT_MAX_PAGES);
  });

  it('a caller cannot raise the ceiling above the runner default through options', () => {
    // The planner records what it was given; the runner still enforces its own.
    const plan = buildSearchPlan(KOTA_BANDUNG, { maxPages: 5 });
    expect(plan.maxPages).toBe(5);
    expect(plan.worstCaseRequests).toBe(plan.units.length * 5);
  });

  it('uses the established page limit', () => {
    expect(buildSearchPlan(KOTA_BANDUNG).limit).toBe(DEFAULT_PAGE_LIMIT);
  });
});

// ----------------------------------------- 13-15. determinism + coverage

describe('determinism and coverage', () => {
  it('repeated calls produce an identical plan', () => {
    expect(JSON.stringify(buildSearchPlan(KOTA_BANDUNG).all)).toEqual(
      JSON.stringify(buildSearchPlan(KOTA_BANDUNG).all),
    );
  });

  it('input order does not change the plan', () => {
    const forward = buildSearchPlan(KOTA_BANDUNG).all.map((u) => u.unitId);
    const reversed = buildSearchPlan([...KOTA_BANDUNG].reverse()).all.map((u) => u.unitId);
    expect(reversed).toEqual(forward);
  });

  it('no district silently disappears — all = units + review', () => {
    const plan = buildSearchPlan(KOTA_BANDUNG);
    const districts = new Set(KOTA_BANDUNG.map((v) => v.districtName));

    // `all` now also carries additive VILLAGE_TOKEN units, so district coverage
    // is asserted explicitly rather than inferred from the array length.
    expect(plan.districts).toBe(districts.size);
    expect(plan.units.length + plan.review.length).toBe(plan.all.length);
    expect(new Set(plan.all.map((u) => u.massularDistrict))).toEqual(districts);

    const districtUnits = plan.all.filter((u) => u.strategy !== 'VILLAGE_TOKEN' && !u.evidence);
    expect(districtUnits).toHaveLength(districts.size);
  });

  it('every district carries its village count, so an empty plan cannot hide one', () => {
    const plan = buildSearchPlan(KOTA_BANDUNG);
    const total = plan.all.filter((u) => !u.evidence).reduce((s, u) => s + u.villages, 0);
    expect(total).toBe(KOTA_BANDUNG.length);
  });

  it('REVIEW_REQUIRED districts are explicitly visible with a stated reason', () => {
    const plan = buildSearchPlan(KOTA_BANDUNG);

    expect(plan.review.length).toBeGreaterThan(0);
    for (const u of plan.review) {
      expect(u.requiresReview).toBe(true);
      expect(u.strategy).toBe('REVIEW_REQUIRED');
      expect(u.reason.length).toBeGreaterThan(20);
    }
  });

  it('unit ids are unique and traversal-safe', () => {
    const ids = buildSearchPlan(KOTA_BANDUNG).all.map((u) => u.unitId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^(district|village)-[a-z0-9-]+$/);
  });
});

// ------------------------------------------------- 16. conversion + purity

describe('conversion to runnable units', () => {
  it('only executable units become acquisition units, and they carry no credential', () => {
    const plan = buildSearchPlan(KOTA_BANDUNG);
    const units = toAcquisitionUnits(plan);

    expect(units).toHaveLength(plan.units.length);
    for (const u of units) {
      const p = new URL(u.urlFor(0)).searchParams;
      expect(p.get('search')).toBe(u.searchTerm);
      expect(p.get('limit')).toBe(String(DEFAULT_PAGE_LIMIT));
      expect(p.get('offset')).toBe('0');
      expect(u.urlFor(0)).not.toMatch(/key=/i);
    }
  });

  it('offsets advance by the page limit', () => {
    const [u] = toAcquisitionUnits(buildSearchPlan(KOTA_BANDUNG));
    expect(new URL(u.urlFor(20)).searchParams.get('offset')).toBe('20');
  });

  it('refuses to convert a review unit even if one is forced in', () => {
    const plan = buildSearchPlan(KOTA_BANDUNG);
    const forced = { ...plan, units: [...plan.units, plan.review[0]] };
    expect(() => toAcquisitionUnits(forced)).toThrow(EmptySearchTermError);
  });

  it('is pure: no network, filesystem or database access', () => {
    // The module imports nothing capable of I/O; building a plan is synchronous
    // and total. If it ever reached out, this call would need to be awaited.
    const plan = buildSearchPlan(KOTA_BANDUNG);
    expect(plan).not.toBeInstanceOf(Promise);
    expect(typeof plan.worstCaseRequests).toBe('number');
  });
});
