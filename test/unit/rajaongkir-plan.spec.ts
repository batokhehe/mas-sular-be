import {
  APPROVED_SCOPE,
  buildAcquisitionPlan,
  DEFAULT_PAGE_LIMIT,
  EmptySearchTermError,
  scopeViolations,
} from '../../prisma/tools/rajaongkir-plan';
import { parseArgs, parseVillages, CONFIRM_FLAG } from '../../prisma/tools/rajaongkir-acquire';
import type { MassularVillage } from '../../prisma/tools/rajaongkir-village-map';

/**
 * PAXELBOX-58. The plan builder is pure, so this file needs no database and no
 * network: it is handed village records and asserts the plan they produce.
 *
 * DISTRICT NAMES AND COUNTS BELOW ARE REAL, measured read-only from the
 * Massular database on 2026-09-01 (PAXELBOX-54/56A): 30 districts summing to
 * 151 villages in Kota Bandung. The village NAMES are synthetic placeholders —
 * nothing here asserts anything about a real village's identity, only about
 * plan shape, determinism and counts.
 */
const DISTRICT_VILLAGE_COUNTS: Array<[string, number]> = [
  ['Sukasari', 4], ['Coblong', 6], ['Babakan Ciparay', 6], ['Bojongloa Kaler', 5],
  ['Andir', 6], ['Cicendo', 6], ['Sukajadi', 5], ['Cidadap', 3],
  ['Bandung Wetan', 3], ['Astanaanyar', 6], ['Regol', 7], ['Batununggal', 8],
  ['Lengkong', 7], ['Cibeunying Kidul', 6], ['Bandung Kulon', 8], ['Kiaracondong', 6],
  ['Bojongloa Kidul', 6], ['Cibeunying Kaler', 4], ['Sumur Bandung', 4], ['Antapani', 4],
  ['Bandung Kidul', 4], ['Buahbatu', 4], ['Rancasari', 4], ['Arcamanik', 4],
  ['Cibiru', 4], ['Ujungberung', 5], ['Gedebage', 4], ['Panyileukan', 4],
  ['Cinambo', 4], ['Mandalajati', 4],
];

function kotaBandungFixture(): MassularVillage[] {
  const out: MassularVillage[] = [];
  DISTRICT_VILLAGE_COUNTS.forEach(([districtName, count], d) => {
    for (let i = 1; i <= count; i++) {
      out.push({
        code: `32.73.${String(d + 1).padStart(2, '0')}.${1000 + i}`,
        name: `${districtName} Village ${i}`,
        postalCode: `40${String(100 + d).padStart(3, '0')}`,
        districtName,
        cityName: 'Kota Bandung',
        provinceName: 'Jawa Barat',
      });
    }
  });
  return out;
}

describe('the fixture matches the approved scope', () => {
  it('is 151 villages across 30 districts', () => {
    const villages = kotaBandungFixture();
    expect(villages).toHaveLength(151);
    expect(new Set(villages.map((v) => v.districtName)).size).toBe(30);
    expect(DISTRICT_VILLAGE_COUNTS.reduce((s, [, c]) => s + c, 0)).toBe(151);
  });

  it('agrees with the recorded APPROVED_SCOPE constant', () => {
    expect(APPROVED_SCOPE.expectedVillages).toBe(151);
    expect(APPROVED_SCOPE.expectedDistricts).toBe(30);
    expect(APPROVED_SCOPE.cityName).toBe('Kota Bandung');
    expect(APPROVED_SCOPE.provinceName).toBe('Jawa Barat');
  });
});

describe('district strategy (default)', () => {
  it('produces one unit per district — 30, not 151', () => {
    const plan = buildAcquisitionPlan(kotaBandungFixture());

    expect(plan.strategy).toBe('district');
    expect(plan.units).toHaveLength(30);
    expect(plan.villageCount).toBe(151);
    expect(plan.districtCount).toBe(30);
  });

  it('every unit carries a non-blank search term and a page limit', () => {
    const plan = buildAcquisitionPlan(kotaBandungFixture());

    expect(plan.limit).toBe(DEFAULT_PAGE_LIMIT);
    for (const u of plan.units) {
      expect(u.searchTerm.trim().length).toBeGreaterThan(0);
      expect(u.limit).toBe(DEFAULT_PAGE_LIMIT);
    }
  });

  it('urlFor produces distinct ascending offsets and never embeds a credential', () => {
    const [unit] = buildAcquisitionPlan(kotaBandungFixture()).units;

    const p0 = new URL(unit.urlFor(0)).searchParams;
    const p20 = new URL(unit.urlFor(20)).searchParams;
    expect(p0.get('offset')).toBe('0');
    expect(p20.get('offset')).toBe('20');
    expect(p0.get('search')).toBe(unit.searchTerm);
    expect(p0.get('limit')).toBe(String(DEFAULT_PAGE_LIMIT));
    expect(unit.urlFor(0)).not.toMatch(/key=/i);
  });

  it('unit keys are unique and traversal-safe', () => {
    const plan = buildAcquisitionPlan(kotaBandungFixture());
    const keys = plan.units.map((u) => u.key);

    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) {
      expect(k).toMatch(/^district-[a-z0-9-]+$/);
      expect(k).not.toContain('..');
    }
  });
});

describe('village strategy', () => {
  it('produces one unit per distinct village name', () => {
    const plan = buildAcquisitionPlan(kotaBandungFixture(), { strategy: 'village' });

    expect(plan.strategy).toBe('village');
    expect(plan.units).toHaveLength(151);
    expect(plan.units.every((u) => u.key.startsWith('village-'))).toBe(true);
  });

  it('collapses duplicate names into one unit — one search is not one village', () => {
    const villages: MassularVillage[] = [
      { code: 'a', name: 'Sukamaju', postalCode: '40001', districtName: 'D1', cityName: 'Kota Bandung', provinceName: 'Jawa Barat' },
      { code: 'b', name: 'Sukamaju', postalCode: '40002', districtName: 'D2', cityName: 'Kota Bandung', provinceName: 'Jawa Barat' },
    ];

    const plan = buildAcquisitionPlan(villages, { strategy: 'village' });

    // Both villages are resolved from the SAME search; the matcher separates them.
    expect(plan.units).toHaveLength(1);
    expect(plan.villageCount).toBe(2);
  });
});

describe('determinism', () => {
  it('the same input yields an identical plan, in identical order', () => {
    const a = buildAcquisitionPlan(kotaBandungFixture());
    const b = buildAcquisitionPlan(kotaBandungFixture());

    expect(a.units.map((u) => u.key)).toEqual(b.units.map((u) => u.key));
    expect(a.units.map((u) => u.urlFor(0))).toEqual(b.units.map((u) => u.urlFor(0)));
  });

  it('input order does not change the plan — a resume must line up with its checkpoint', () => {
    const forward = kotaBandungFixture();
    const shuffled = [...forward].reverse();

    expect(buildAcquisitionPlan(shuffled).units.map((u) => u.key)).toEqual(
      buildAcquisitionPlan(forward).units.map((u) => u.key),
    );
  });
});

describe('blank search terms', () => {
  it('refuses to build a unit with a blank term rather than spending a 422', () => {
    const villages: MassularVillage[] = [
      { code: 'a', name: 'X', postalCode: '40001', districtName: '   ', cityName: 'Kota Bandung', provinceName: 'Jawa Barat' },
    ];

    expect(() => buildAcquisitionPlan(villages)).toThrow(EmptySearchTermError);
  });
});

describe('scope guard', () => {
  it('accepts the approved 151-village set', () => {
    expect(scopeViolations(kotaBandungFixture())).toEqual([]);
  });

  it('rejects a short set', () => {
    expect(scopeViolations(kotaBandungFixture().slice(0, 150)).join(' ')).toMatch(/expected 151 villages, got 150/);
  });

  it('rejects a village outside the approved city or province', () => {
    const out = kotaBandungFixture();
    out[0] = { ...out[0], cityName: 'Kota Cimahi', provinceName: 'Banten' };

    const problems = scopeViolations(out).join(' ');
    expect(problems).toMatch(/city must be exactly \[Kota Bandung\]/);
    expect(problems).toMatch(/province must be exactly \[Jawa Barat\]/);
  });

  it('rejects duplicate village codes', () => {
    const dup = kotaBandungFixture();
    dup[1] = { ...dup[1], code: dup[0].code };

    expect(scopeViolations(dup).join(' ')).toMatch(/duplicate village codes/);
  });
});

describe('entry-point guardrails', () => {
  it('importing the entry point runs nothing', () => {
    // If it self-executed, requiring this spec would already have made requests.
    expect(typeof parseArgs).toBe('function');
  });

  it('defaults to not-confirmed, so an argv-less invocation cannot acquire', () => {
    expect(parseArgs([]).confirmed).toBe(false);
    expect(parseArgs(['--villages', 'v.json']).confirmed).toBe(false);
    expect(parseArgs(['--villages', 'v.json', CONFIRM_FLAG]).confirmed).toBe(true);
  });

  it('defaults to the district strategy and rejects an unknown one', () => {
    expect(parseArgs([]).strategy).toBe('district');
    expect(() => parseArgs(['--strategy', 'fuzzy'])).toThrow(/must be "district" or "village"/);
  });

  it('rejects a malformed villages file before any plan is built', () => {
    expect(() => parseVillages({})).toThrow(/must contain a JSON array/);
    expect(() => parseVillages([{ code: 'a' }])).toThrow(/"name" must be a non-empty string/);
    expect(() => parseVillages([{ code: 'a', name: 'b', districtName: 'c', cityName: 'd', provinceName: 'e', postalCode: 5 }])).toThrow(
      /"postalCode" must be a string or null/,
    );
  });

  it('accepts a well-formed village record with a null postal code', () => {
    const parsed = parseVillages([
      { code: 'a', name: 'b', districtName: 'c', cityName: 'd', provinceName: 'e', postalCode: null },
    ]);
    expect(parsed).toHaveLength(1);
  });
});
