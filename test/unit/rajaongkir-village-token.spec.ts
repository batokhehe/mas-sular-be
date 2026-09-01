import {
  buildSearchPlan,
  toAcquisitionUnits,
  villageTokenProblems,
  VALIDATED_VILLAGE_TOKENS,
  type VillageTokenEvidence,
} from '../../prisma/tools/rajaongkir-plan';
import type { MassularVillage } from '../../prisma/tools/rajaongkir-village-map';

/**
 * PAXELBOX-60L. The VILLAGE_TOKEN strategy.
 *
 * PAXELBOX-60K measured one term — "Braga" — and it came back with a single
 * row. The temptation is to read that as "village names are safe search terms".
 * The repository already disproves that: "Sukajadi" returned 57 rows over 3
 * pages, and BABAKAN appeared in 79 of 96 rows of the Babakan Ciparay result.
 * These tests exist to hold the line: a measurement promotes ONE term, never a
 * class, and an unmeasured token must stay structurally unable to reach the
 * runner.
 */

const jb = { cityName: 'Kota Bandung', provinceName: 'Jawa Barat' };
let seq = 0;
const v = (name: string, districtName: string, postalCode = '40111'): MassularVillage => ({
  code: `32.73.${String(++seq).padStart(2, '0')}.1001`,
  name,
  postalCode,
  districtName,
  ...jb,
});

const SCOPE: MassularVillage[] = [
  v('Braga', 'Sumur Bandung', '40111'),
  v('Merdeka', 'Sumur Bandung', '40113'),
  v('Kebon Pisang', 'Sumur Bandung', '40112'),
  v('Campaka', 'Andir'),
  v('Kujangsari', 'Bandung Kidul'),
];

const braga = () => buildSearchPlan(SCOPE).all.find((u) => u.unitId === 'village-braga')!;

// ------------------------------------------------- 1-5. the validated unit

describe('the one measured village token', () => {
  it('VALIDATED_VILLAGE_TOKENS holds exactly one entry — Braga', () => {
    expect(VALIDATED_VILLAGE_TOKENS).toHaveLength(1);
    expect(VALIDATED_VILLAGE_TOKENS[0].searchTerm).toBe('Braga');
    expect(VALIDATED_VILLAGE_TOKENS[0].evidenceSource).toBe('PAXELBOX-60K');
  });

  it('Braga is planned as an executable VILLAGE_TOKEN unit', () => {
    const u = braga();
    expect(u.strategy).toBe('VILLAGE_TOKEN');
    expect(u.searchTerm).toBe('Braga');
    expect(u.requiresReview).toBe(false);
    expect(u.risk).toBe('LOW');
  });

  it('carries the measurement that justified it', () => {
    const e = braga().evidence!;
    expect(e).toMatchObject({
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
    });
    expect(braga().knownEvidence).toMatch(/PAXELBOX-60K.*4949.*40111/);
    expect(braga().targetVillages).toEqual(['Braga']);
  });

  it('has a deterministic id that cannot collide with a district unit', () => {
    const ids = buildSearchPlan(SCOPE).all.map((u) => u.unitId);
    expect(braga().unitId).toBe('village-braga');
    expect(braga().unitId).not.toBe('district-sumur-bandung');
    expect(ids).toContain('district-sumur-bandung');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('converts into a runnable acquisition unit', () => {
    const units = toAcquisitionUnits(buildSearchPlan(SCOPE));
    const u = units.find((x) => x.key === 'village-braga')!;

    expect(u.searchTerm).toBe('Braga');
    const p = new URL(u.urlFor(0)).searchParams;
    expect(p.get('search')).toBe('Braga');
    expect(p.get('offset')).toBe('0');
    expect(u.urlFor(0)).not.toMatch(/key=/i);
  });

  it('does NOT make its district executable — a token resolves a village, not a district', () => {
    const district = buildSearchPlan(SCOPE).all.find((u) => u.unitId === 'district-sumur-bandung')!;
    expect(district.strategy).toBe('REVIEW_REQUIRED');
    expect(district.searchTerm).toBeNull();
    // Merdeka and Kebon Pisang remain unaddressed.
    expect(braga().targetVillages).not.toContain('Merdeka');
  });
});

// ------------------------------------------ 6-7. unmeasured tokens are inert

describe('an unmeasured village token cannot execute', () => {
  const unmeasured: VillageTokenEvidence = {
    searchTerm: 'Merdeka',
    massularDistrict: 'Sumur Bandung',
    massularVillages: ['Merdeka'],
    measuredRows: 0,
    measuredPages: 0,
    measuredLimit: 0,
    destinationIds: [],
    postalCodes: [],
    rajaOngkirDistrict: '',
    rajaOngkirVillage: '',
    evidenceSource: '',
  };

  it('is planned as REVIEW_REQUIRED with its deficiencies named', () => {
    const plan = buildSearchPlan(SCOPE, { villageTokens: [unmeasured] });
    const u = plan.all.find((x) => x.unitId === 'village-merdeka')!;

    expect(u.strategy).toBe('REVIEW_REQUIRED');
    expect(u.searchTerm).toBeNull();
    expect(u.requiresReview).toBe(true);
    expect(u.reason).toMatch(/no destination id was identified/);
  });

  it('cannot reach toAcquisitionUnits', () => {
    const plan = buildSearchPlan(SCOPE, { villageTokens: [unmeasured] });
    expect(toAcquisitionUnits(plan).map((u) => u.key)).not.toContain('village-merdeka');
  });

  it('a token whose measurement FILLED its page is refused — boundedness unproven', () => {
    const full: VillageTokenEvidence = { ...VALIDATED_VILLAGE_TOKENS[0], searchTerm: 'Sukamaju', measuredRows: 20, measuredLimit: 20 };
    expect(villageTokenProblems(full).join(' ')).toMatch(/page was full/);

    const plan = buildSearchPlan(SCOPE, { villageTokens: [full] });
    expect(plan.all.find((u) => u.unitId === 'village-sukamaju')!.requiresReview).toBe(true);
  });

  it('the standing proposals from 60J are still nowhere in the executable set', () => {
    const terms = toAcquisitionUnits(buildSearchPlan(SCOPE)).map((u) => u.searchTerm);
    for (const t of ['Kujangsari', 'Mengger', 'Wates', 'Merdeka', 'Cikutra', 'Padasuka', 'Cigadung', 'Jamika']) {
      expect(terms).not.toContain(t);
    }
  });

  it('ignores a measured token whose district is outside the planned scope', () => {
    const elsewhere: VillageTokenEvidence = { ...VALIDATED_VILLAGE_TOKENS[0], massularDistrict: 'Somewhere Else' };
    const plan = buildSearchPlan(SCOPE, { villageTokens: [elsewhere] });
    expect(plan.all.some((u) => u.unitId === 'village-braga')).toBe(false);
  });
});

// ------------------------------------------- 8-15. the guarantees still hold

describe('existing planner guarantees are untouched', () => {
  it('generic district tokens are still rejected', () => {
    const u = buildSearchPlan([v('X', 'Bandung')]).all[0];
    expect(u.strategy).toBe('REVIEW_REQUIRED');
    expect(u.reason).toMatch(/generic administrative token/);
  });

  it('no executable unit carries a blank term', () => {
    for (const u of toAcquisitionUnits(buildSearchPlan(SCOPE))) {
      expect(u.searchTerm.trim().length).toBeGreaterThan(0);
    }
  });

  it('existing district unit ids are unchanged', () => {
    const ids = buildSearchPlan(SCOPE).all.map((u) => u.unitId);
    for (const id of ['district-sumur-bandung', 'district-andir', 'district-bandung-kidul']) {
      expect(ids).toContain(id);
    }
  });

  it('the real checkpoint unit ids remain recognised by the new plan', () => {
    // The five completed units from the committed baseline.
    const completed = [
      'district-andir', 'district-antapani', 'district-arcamanik',
      'district-astanaanyar', 'district-babakan-ciparay',
    ];
    const scope = [
      v('Campaka', 'Andir'), v('Antapani Kidul', 'Antapani'), v('Sukamiskin', 'Arcamanik'),
      v('Karasak', 'Astanaanyar'), v('Babakan', 'Babakan Ciparay'),
    ];
    const ids = new Set(buildSearchPlan(scope).all.map((u) => u.unitId));
    for (const id of completed) expect(ids).toContain(id);
  });

  it('repeated calls produce identical output', () => {
    expect(JSON.stringify(buildSearchPlan(SCOPE))).toBe(JSON.stringify(buildSearchPlan(SCOPE)));
  });

  it('every district stays represented, and village units are additive', () => {
    const plan = buildSearchPlan(SCOPE);
    const districts = new Set(SCOPE.map((x) => x.districtName));

    expect(plan.districts).toBe(districts.size);
    expect(plan.villageTokenUnits).toHaveLength(1);
    expect(plan.all).toHaveLength(districts.size + 1);
    expect(plan.units.length + plan.review.length).toBe(plan.all.length);
  });

  it('is pure — no runner, no network, no filesystem', () => {
    const plan = buildSearchPlan(SCOPE);
    expect(plan).not.toBeInstanceOf(Promise);
    // urlFor only builds a string; nothing is dispatched.
    expect(typeof toAcquisitionUnits(plan)[0].urlFor(0)).toBe('string');
  });
});
