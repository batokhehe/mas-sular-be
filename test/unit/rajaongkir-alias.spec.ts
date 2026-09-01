import {
  KOTA_BANDUNG_ALIASES,
  affectedVillages,
  aliasTables,
  villageAliasKey,
  type ApprovedAlias,
} from '../../prisma/tools/rajaongkir-alias';
import { confirmedAliases } from '../../prisma/tools/rajaongkir-province-alias';
import { mapVillages, type MassularVillage, type RajaOngkirDestination } from '../../prisma/tools/rajaongkir-village-map';

/**
 * PAXELBOX-60I. The operator-approved aliases, and — more importantly — the
 * guarantee that an alias cannot manufacture a match.
 *
 * An alias only widens which candidates a village GATHERS. The postal code
 * still decides, AMBIGUOUS still blocks, and city name is still not identity.
 * The tests below try to break exactly that: same names with a wrong postal
 * code, two candidates after aliasing, and a village alias leaking into a
 * same-named village in another district.
 */

const ro = (
  id: number,
  district: string,
  subdistrict: string,
  zip: string | null,
  province = 'JAWA BARAT',
  city = 'BANDUNG',
): RajaOngkirDestination => ({ id, provinceName: province, cityName: city, districtName: district, subdistrictName: subdistrict, zipCode: zip });

const mv = (name: string, districtName: string, postalCode: string | null, code = `c-${name}`): MassularVillage => ({
  code,
  name,
  postalCode,
  districtName,
  cityName: 'Kota Bandung',
  provinceName: 'Jawa Barat',
});

const withAliases = (v: MassularVillage[], pool: RajaOngkirDestination[], entries?: ApprovedAlias[]) =>
  mapVillages(v, pool, { province: confirmedAliases(), ...aliasTables(entries) });

// --------------------------------------------------------- the approved set

describe('the approved alias set', () => {
  it('contains exactly the 14 operator-approved entries', () => {
    expect(KOTA_BANDUNG_ALIASES).toHaveLength(14);
    expect(KOTA_BANDUNG_ALIASES.filter((a) => a.kind === 'DISTRICT')).toHaveLength(2);
    expect(KOTA_BANDUNG_ALIASES.filter((a) => a.kind === 'VILLAGE')).toHaveLength(12);
  });

  it('names exactly the two approved districts', () => {
    expect(aliasTables().district).toEqual({
      Antapani: 'ANTAPANI (CICADAS)',
      Buahbatu: 'BUAHBATU (MARGACINTA)',
    });
  });

  it('excludes everything the operator explicitly withheld', () => {
    const all = JSON.stringify(KOTA_BANDUNG_ALIASES);
    // Cinambo postal conflict, membership anomalies, and the two unknowns.
    for (const withheld of ['Cisaranten Wetan', 'Pakemitan', 'Sukamulya', 'Babakan Penghulu', 'Sindang Jaya', 'SINDANG JAYA', 'Astanaanyar', 'Ujungberung']) {
      expect(all).not.toContain(withheld);
    }
  });

  it('carries the evidence each entry was approved on', () => {
    for (const a of KOTA_BANDUNG_ALIASES) {
      expect(a.destinationIds.length).toBeGreaterThan(0);
      expect(a.postalCode).toMatch(/^\d{5}$/);
      expect(a.note.length).toBeGreaterThan(5);
      if (a.kind === 'VILLAGE') expect(a.districtContext).toBeTruthy();
    }
  });

  it('province aliases remain empty — this phase approved none', () => {
    expect(confirmedAliases()).toEqual({});
  });

  it('refuses to build a table from an unscoped village alias', () => {
    expect(() =>
      aliasTables([{ kind: 'VILLAGE', massular: 'X', rajaOngkir: 'X', destinationIds: [1], postalCode: '40000', note: 'n' }]),
    ).toThrow(/districtContext/);
  });
});

// ------------------------------------------------- district alias behaviour

describe('district alias', () => {
  const antapani = [
    mv('Antapani Kidul', 'Antapani', '40291'),
    mv('Antapani Kulon', 'Antapani', '40291'),
  ];
  const pool = [ro(4830, 'ANTAPANI (CICADAS)', 'ANTAPANI KIDUL', '40291'), ro(4831, 'ANTAPANI (CICADAS)', 'ANTAPANI KULON', '40291')];

  it('resolves villages blocked only by the district label', () => {
    expect(mapVillages(antapani, pool).matched).toBe(0); // without the alias
    const after = withAliases(antapani, pool);
    expect(after.matched).toBe(2);
    expect(after.matches.map((m) => m.rajaOngkirId).sort()).toEqual([4830, 4831]);
  });

  it('does NOT match when the postal code disagrees, even with the alias', () => {
    const wrongZip = [ro(4830, 'ANTAPANI (CICADAS)', 'ANTAPANI KIDUL', '99999')];
    const report = withAliases([antapani[0]], wrongZip);

    expect(report.matched).toBe(0);
    expect(report.matches[0].outcome).toBe('REVIEW_REQUIRED');
    expect(report.matches[0].rajaOngkirId).toBeUndefined();
  });

  it('does NOT match when the province disagrees', () => {
    const wrongProvince = [ro(4830, 'ANTAPANI (CICADAS)', 'ANTAPANI KIDUL', '40291', 'BANTEN')];
    expect(withAliases([antapani[0]], wrongProvince).matched).toBe(0);
  });

  it('still ignores city name as identity', () => {
    const otherCity = [ro(4830, 'ANTAPANI (CICADAS)', 'ANTAPANI KIDUL', '40291', 'JAWA BARAT', 'SOMEWHERE ELSE')];
    // City is deliberately not part of the key, so this still matches.
    expect(withAliases([antapani[0]], otherCity).matched).toBe(1);
  });
});

// -------------------------------------------------- village alias behaviour

describe('village alias', () => {
  it('resolves a spelling variant within the right district', () => {
    const v = [mv('Rancabolang', 'Gedebage', '40294')];
    const pool = [ro(4958, 'GEDEBAGE', 'RANCABALONG', '40294')];

    expect(mapVillages(v, pool).matched).toBe(0);
    const after = withAliases(v, pool);
    expect(after.matched).toBe(1);
    expect(after.matches[0].rajaOngkirId).toBe(4958);
  });

  it('is scoped by district — it cannot leak to a same-named village elsewhere', () => {
    // A village also called "Rancabolang" in a district nobody reviewed.
    const elsewhere = [mv('Rancabolang', 'Some Other District', '40294')];
    const pool = [ro(4958, 'SOME OTHER DISTRICT', 'RANCABALONG', '40294')];

    // The alias key is Gedebage|Rancabolang, so this must NOT be rewritten.
    expect(withAliases(elsewhere, pool).matched).toBe(0);
    expect(villageAliasKey('Gedebage', 'Rancabolang')).not.toBe(villageAliasKey('Some Other District', 'Rancabolang'));
  });

  it('stacks with a district alias when a village needs both', () => {
    const v = [mv('Jati Sari', 'Buahbatu', '40286')];
    const pool = [ro(4929, 'BUAHBATU (MARGACINTA)', 'JATISARI', '40286')];

    expect(mapVillages(v, pool).matched).toBe(0);
    expect(withAliases(v, pool).matches[0].rajaOngkirId).toBe(4929);
  });

  it('does NOT match on postal disagreement', () => {
    const v = [mv('Rancabolang', 'Gedebage', '40294')];
    const pool = [ro(4958, 'GEDEBAGE', 'RANCABALONG', '40111')];
    expect(withAliases(v, pool).matched).toBe(0);
  });
});

// ----------------------------------------------------- safety invariants

describe('an alias cannot weaken the matcher', () => {
  it('AMBIGUOUS still blocks after aliasing', () => {
    const v = [mv('Rancabolang', 'Gedebage', '40294')];
    const pool = [ro(4958, 'GEDEBAGE', 'RANCABALONG', '40294'), ro(9999, 'GEDEBAGE', 'RANCABALONG', '40294')];

    const report = withAliases(v, pool);
    expect(report.matches[0].outcome).toBe('AMBIGUOUS');
    expect(report.matched).toBe(0);
    expect(report.safeToApply).toBe(false);
    expect(report.blockers.join(' ')).toMatch(/more than one/);
  });

  it('a missing Massular postal code still yields REVIEW_REQUIRED', () => {
    const v = [mv('Rancabolang', 'Gedebage', null)];
    const pool = [ro(4958, 'GEDEBAGE', 'RANCABALONG', '40294')];
    expect(withAliases(v, pool).matches[0].outcome).toBe('REVIEW_REQUIRED');
  });

  it('an unaliased mismatch is still NOT_FOUND — no fuzzy fallback', () => {
    // Deliberately close but not approved: one letter off.
    const v = [mv('Rancabolangx', 'Gedebage', '40294')];
    const pool = [ro(4958, 'GEDEBAGE', 'RANCABALONG', '40294')];
    expect(withAliases(v, pool).matches[0].outcome).toBe('NOT_FOUND');
  });

  it('Cinambo remains REVIEW_REQUIRED — the postal conflict was NOT aliased away', () => {
    const v = [mv('Pakemitan', 'Cinambo', '40296')];
    const pool = [ro(4954, 'CINAMBO', 'PAKEMITAN', '40294')];

    const report = withAliases(v, pool);
    expect(report.matches[0].outcome).toBe('REVIEW_REQUIRED');
    expect(report.matches[0].reason).toMatch(/postal code differs/);
  });

  it('the membership anomalies are still refused', () => {
    // Massular puts Sindang Jaya in Mandalajati @40195; RO has it in Arcamanik @40293.
    const v = [mv('Sindang Jaya', 'Mandalajati', '40195')];
    const pool = [ro(4852, 'ARCAMANIK', 'SINDANG JAYA', '40293')];
    expect(withAliases(v, pool).matches[0].outcome).toBe('NOT_FOUND');
  });

  it('passing no aliases behaves exactly as before', () => {
    const v = [mv('Antapani Kidul', 'Antapani', '40291')];
    const pool = [ro(4830, 'ANTAPANI (CICADAS)', 'ANTAPANI KIDUL', '40291')];
    expect(mapVillages(v, pool).matched).toBe(0);
    expect(mapVillages(v, pool, {}).matched).toBe(0);
  });

  it('a bare record is still read as province aliases (back-compat)', () => {
    const v = [{ ...mv('X', 'D', '40000'), provinceName: 'Daerah Khusus Ibukota Jakarta' }];
    const pool = [ro(1, 'D', 'X', '40000', 'DKI JAKARTA')];
    expect(mapVillages(v, pool).matched).toBe(0);
    expect(mapVillages(v, pool, { 'Daerah Khusus Ibukota Jakarta': 'DKI JAKARTA' }).matched).toBe(1);
  });
});

// ---------------------------------------------------------- affected set

describe('affectedVillages', () => {
  it('reports exactly the villages the approved aliases target', () => {
    const villages = [
      mv('Antapani Kidul', 'Antapani', '40291'),
      mv('Gegerkalong', 'Sukasari', '40153'),
      mv('Isola', 'Sukasari', '40154'), // untouched
    ];
    expect(affectedVillages(villages).map((v) => v.name).sort()).toEqual(['Antapani Kidul', 'Gegerkalong']);
  });
});
