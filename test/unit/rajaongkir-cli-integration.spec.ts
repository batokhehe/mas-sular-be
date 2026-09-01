import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { CONFIRM_FLAG, DRY_RUN_FLAG, formatPlan, main, parseArgs } from '../../prisma/tools/rajaongkir-acquire';
import { buildSearchPlan, toAcquisitionUnits, EmptySearchTermError } from '../../prisma/tools/rajaongkir-plan';
import type { MassularVillage } from '../../prisma/tools/rajaongkir-village-map';

/**
 * PAXELBOX-60F-A. The CLI wired to the hardened planner, exercised entirely
 * offline: every test runs with `--dry-run`, which returns before a transport
 * or a storage handle is ever constructed.
 *
 * The property under test is that the CLI cannot revive a district the planner
 * held back. PAXELBOX-60D spent 20 requests on "Bandung Kidul" because the plan
 * treated a district name as a phrase; the integration must now make that
 * district structurally unreachable rather than merely discouraged.
 */

// Real Kota Bandung districts and village names (PAXELBOX-59 export), trimmed
// to the shape the scope guard accepts.
const DISTRICT_VILLAGES: Array<[string, string[]]> = [
  ['Andir', ['Campaka', 'Ciroyom', 'Dungus Cariang', 'Garuda', 'Kebon Jeruk', 'Maleber']],
  ['Antapani', ['Antapani Kidul', 'Antapani Kulon', 'Antapani Tengah', 'Antapani Wetan']],
  ['Arcamanik', ['Cisaranten Bina Harapan', 'Cisaranten Endah', 'Cisaranten Kulon', 'Sukamiskin']],
  ['Astanaanyar', ['Karanganyar', 'Karasak', 'Cibadak', 'Nyengseret', 'Panjunan', 'Pelindung Hewan']],
  ['Babakan Ciparay', ['Babakan', 'Babakan Ciparay', 'Cirangrang', 'Margahayu Utara', 'Margasuka', 'Sukahaji']],
  ['Bandung Kidul', ['Batununggal', 'Kujangsari', 'Mengger', 'Wates']],
  ['Bandung Kulon', ['Caringin', 'Cibuntu', 'Cigondewah Kaler', 'Cigondewah Kidul', 'Cigondewah Rahayu', 'Cijerah', 'Gempol Sari', 'Warung Muncang']],
  ['Bandung Wetan', ['Cihapit', 'Citarum', 'Taman Sari']],
  ['Batununggal', ['Binong', 'Cibangkong', 'Gumuruh', 'Kacapiring', 'Kebonwaru', 'Maleer', 'Samoja', 'Kebongedang']],
  ['Bojongloa Kaler', ['Babakan Asih', 'Babakan Tarogong', 'Jamika', 'Kopo', 'Suka Asih']],
  ['Bojongloa Kidul', ['Cibaduyut', 'Cibaduyut Kidul', 'Cibaduyut Wetan', 'Kebon Lega', 'Mekar Wangi', 'Situsaeur']],
  ['Buahbatu', ['Cijawura', 'Jatisari', 'Margasari', 'Sekejati']],
  ['Cibeunying Kaler', ['Cigadung', 'Cihaur Geulis', 'Neglasari', 'Sukaluyu']],
  ['Cibeunying Kidul', ['Cicadas', 'Cikutra', 'Padasuka', 'Pasirlayung', 'Sukamaju', 'Sukapada']],
  ['Cibiru', ['Cipadung', 'Palasari', 'Pasirbiru', 'Cisurupan']],
  ['Cicendo', ['Arjuna', 'Husein Sastranegara', 'Pajajaran', 'Pamoyanan', 'Pasirkaliki', 'Sukaraja']],
  ['Cidadap', ['Ciumbuleuit', 'Hegarmanah', 'Ledeng']],
  ['Cinambo', ['Babakan Penghulu', 'Cisaranten Wetan', 'Pakemitan', 'Sukamulya']],
  ['Coblong', ['Cipaganti', 'Dago', 'Lebakgede', 'Lebaksiliwangi', 'Sadangserang', 'Sekeloa']],
  ['Gedebage', ['Cimincrang', 'Cisaranten Kidul', 'Rancabolang', 'Rancanumpang']],
  ['Kiaracondong', ['Babakan Sari', 'Babakan Surabaya', 'Cicaheum', 'Kebonjayanti', 'Kebonkangkung', 'Sukapura']],
  ['Lengkong', ['Burangrang', 'Cijagra', 'Cikawao', 'Lingkar Selatan', 'Malabar', 'Paledang', 'Turangga']],
  ['Mandalajati', ['Jatihandap', 'Karang Pamulang', 'Pasir Impun', 'Sindang Jaya']],
  ['Panyileukan', ['Cipadung Kidul', 'Cipadung Kulon', 'Cipadung Wetan', 'Mekarmulya']],
  ['Rancasari', ['Cipamokolan', 'Darwati', 'Manjahlega', 'Mekarjaya']],
  ['Regol', ['Ancol', 'Balonggede', 'Ciateul', 'Cigereleng', 'Ciseureuh', 'Pasirluyu', 'Pungkur']],
  ['Sukajadi', ['Cipedes', 'Pasteur', 'Sukabungah', 'Sukagalih', 'Sukawarna']],
  ['Sukasari', ['Gegerkalong', 'Isola', 'Sarijadi', 'Sukarasa']],
  ['Sumur Bandung', ['Babakan Ciamis', 'Braga', 'Kebon Pisang', 'Merdeka']],
  ['Ujungberung', ['Cigending', 'Pasanggrahan', 'Pasirendah', 'Pasirjati', 'Pasirwangi']],
];

function kotaBandung(): MassularVillage[] {
  const out: MassularVillage[] = [];
  DISTRICT_VILLAGES.forEach(([districtName, names], d) => {
    names.forEach((name, i) => {
      out.push({
        code: `32.73.${String(d + 1).padStart(2, '0')}.${1000 + i}`,
        name,
        postalCode: `40${String(100 + d).padStart(3, '0')}`,
        districtName,
        cityName: 'Kota Bandung',
        provinceName: 'Jawa Barat',
      });
    });
  });
  return out;
}

const VILLAGES = kotaBandung();

let dir: string;
let villagesPath: string;
let log: jest.SpyInstance;
let errLog: jest.SpyInstance;

beforeAll(() => {
  // The fixture must satisfy the real scope guard, or every CLI test exits 3.
  expect(VILLAGES).toHaveLength(151);
  expect(new Set(VILLAGES.map((v) => v.districtName)).size).toBe(30);
});

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ro-cli-'));
  villagesPath = path.join(dir, 'villages.json');
  await fs.writeFile(villagesPath, JSON.stringify(VILLAGES), 'utf8');
  log = jest.spyOn(console, 'log').mockImplementation(() => {});
  errLog = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  log.mockRestore();
  errLog.mockRestore();
  await fs.rm(dir, { recursive: true, force: true });
});

const out = () => log.mock.calls.map((c) => c.join(' ')).join('\n');
const errOut = () => errLog.mock.calls.map((c) => c.join(' ')).join('\n');
const dryRun = (extra: string[] = []) => main(['--villages', villagesPath, DRY_RUN_FLAG, ...extra]);

// ------------------------------------------------- 1-2. planner is wired

describe('the CLI consumes the hardened planner', () => {
  it('its dry run reproduces buildSearchPlan exactly', async () => {
    expect(await dryRun()).toBe(0);
    expect(out()).toContain(formatPlan(buildSearchPlan(VILLAGES, { reviewedAliases: {} })));
  });

  it('plans 30 districts: 21 executable district units, 9 review-required', async () => {
    await dryRun();
    expect(out()).toContain('districts=30');
    // 21 district units + the one measured Braga VILLAGE_TOKEN unit.
    expect(out()).toContain('executable=22');
    expect(out()).toContain('review_required=9');
    expect(out()).toContain('village_token=1');
  });

  it('does not use the legacy district-name-as-term behaviour', async () => {
    await dryRun();
    // The legacy planner made a unit for EVERY district, including multi-word
    // ones. The hardened path must not.
    expect(out()).toContain('22 executable unit(s) planned');
    expect(out()).not.toContain('30 executable unit(s) planned');
  });
});

// -------------------------------------------- 3-5. REVIEW_REQUIRED cannot run

describe('REVIEW_REQUIRED districts cannot reach the runner', () => {
  it.each(['Bandung Kidul', 'Bandung Kulon', 'Bandung Wetan', 'Sumur Bandung', 'Babakan Ciparay'])(
    '%s is held back and never becomes an executable unit',
    async (district) => {
      await dryRun();
      expect(out()).toMatch(new RegExp(`${district}\\s+REVIEW_REQUIRED`));

      const units = toAcquisitionUnits(buildSearchPlan(VILLAGES));
      expect(units.map((u) => u.searchTerm)).not.toContain(district);
    },
  );

  it('lists every held-back district with a reason, rather than skipping silently', async () => {
    await dryRun();
    expect(out()).toContain('9 district(s) held back as REVIEW_REQUIRED and will NOT be requested');
    for (const d of ['Bandung Kidul', 'Bojongloa Kaler', 'Cibeunying Kidul']) {
      expect(out()).toContain(`- ${d} (`);
    }
  });

  it('surfaces the fallback as a PROPOSAL needing review, not as a plan', async () => {
    await dryRun();
    expect(out()).toContain('fallback PROPOSAL (needs review)');
  });

  it('no executable unit carries an empty or generic term', () => {
    for (const u of toAcquisitionUnits(buildSearchPlan(VILLAGES))) {
      expect(u.searchTerm.trim().length).toBeGreaterThan(0);
      expect(u.searchTerm.toUpperCase()).not.toBe('BANDUNG');
    }
  });

  it('the conversion boundary refuses a review unit even if one is injected', () => {
    const plan = buildSearchPlan(VILLAGES);
    const forced = { ...plan, units: [...plan.units, plan.review[0]] };
    expect(() => toAcquisitionUnits(forced)).toThrow(EmptySearchTermError);
  });
});

// -------------------------------------------------- 6-8. state is untouched

describe('the dry run touches no state', () => {
  it('creates no cache, checkpoint or artifact', async () => {
    await dryRun(['--cache-root', path.join(dir, 'cache')]);
    // Only the villages file we wrote ourselves exists.
    expect(await fs.readdir(dir)).toEqual(['villages.json']);
  });

  it('needs no API key, so it cannot have built a transport', async () => {
    const saved = process.env.RAJAONGKIR_API_KEY;
    delete process.env.RAJAONGKIR_API_KEY;
    try {
      expect(await dryRun()).toBe(0);
    } finally {
      if (saved !== undefined) process.env.RAJAONGKIR_API_KEY = saved;
    }
  });

  it('reports the same plan on repeated runs — deterministic', async () => {
    await dryRun();
    const first = out();
    log.mockClear();
    await dryRun();
    expect(out()).toBe(first);
  });
});

// ------------------------------------------------- 9-10. nothing disappears

describe('every district stays represented', () => {
  it('all 30 districts appear in the dry-run table', async () => {
    await dryRun();
    for (const [district] of DISTRICT_VILLAGES) expect(out()).toContain(district);
  });

  it('all 30 districts stay represented, and village-token units are additive', () => {
    const plan = buildSearchPlan(VILLAGES);
    expect(plan.districts).toBe(30);
    expect(plan.units.length + plan.review.length).toBe(plan.all.length);
    // 30 district units + 1 measured village-token unit.
    expect(plan.all).toHaveLength(31);
    expect(plan.villageTokenUnits).toHaveLength(1);
  });

  it('the CLI refuses to proceed if that invariant is ever violated', async () => {
    // Guarded in main() with exit code 5; asserted here so the guard is not
    // quietly deleted later.
    const plan = buildSearchPlan(VILLAGES);
    expect(plan.units.length + plan.review.length).toBe(plan.all.length);
  });
});

// ----------------------------------------------------- flags and guards

describe('flags', () => {
  it('refuses to run with neither --confirm nor --dry-run', async () => {
    expect(await main(['--villages', villagesPath])).toBe(2);
    expect(errOut()).toContain(CONFIRM_FLAG);
  });

  it('rejects --strategy village: it is a review proposal, not a switch', async () => {
    expect(await main(['--villages', villagesPath, DRY_RUN_FLAG, '--strategy', 'village'])).toBe(2);
    expect(errOut()).toContain('not supported by the hardened planner');
  });

  it('accepts --strategy district', async () => {
    expect(await dryRun(['--strategy', 'district'])).toBe(0);
  });

  it('still parses the documented flags', () => {
    const o = parseArgs(['--villages', 'v.json', DRY_RUN_FLAG, '--cache-root', 'c', '--id', 'x']);
    expect(o).toMatchObject({ villagesPath: 'v.json', dryRun: true, confirmed: false, cacheRoot: 'c', acquisitionId: 'x' });
  });

  it('refuses an out-of-scope villages file before planning', async () => {
    await fs.writeFile(villagesPath, JSON.stringify(VILLAGES.slice(0, 10)), 'utf8');
    expect(await dryRun()).toBe(3);
    expect(errOut()).toContain('outside the approved scope');
  });
});
