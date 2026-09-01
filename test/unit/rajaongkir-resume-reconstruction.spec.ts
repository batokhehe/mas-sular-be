import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseArtifact, reconstructAcquiredUnits } from '../../prisma/tools/rajaongkir-acquire';
import {
  poolFrom,
  runPaginatedAcquisition,
  type PaginatedAcquisitionUnit,
  type RajaOngkirDestinationRaw,
} from '../../prisma/tools/rajaongkir-acquisition';
import {
  artifactName,
  CHECKPOINT_FILENAME,
  CorruptArtifactError,
  createFileStorage,
  MissingArtifactError,
} from '../../prisma/tools/rajaongkir-storage';
import { mapVillages, type MassularVillage } from '../../prisma/tools/rajaongkir-village-map';

/**
 * PAXELBOX-60F-B. Resumed-run pool reconstruction, exercised offline in a temp
 * directory, plus a READ-ONLY check against the real PAXELBOX-60 artifacts.
 *
 * The defect being fixed: `runPaginatedAcquisition` skips units the checkpoint
 * already claims, and `result.acquired` therefore holds only the current run's
 * work. Mapping from that alone silently drops every district acquired on an
 * earlier day — a mapping that looks fine and under-reports.
 */

const row = (id: number, subdistrict: string, district: string): RajaOngkirDestinationRaw => ({
  id,
  label: `${subdistrict}, ${district}, BANDUNG, JAWA BARAT, 40294`,
  province_name: 'JAWA BARAT',
  city_name: 'BANDUNG',
  district_name: district,
  subdistrict_name: subdistrict,
  zip_code: '40294',
});
const ok = (rows: RajaOngkirDestinationRaw[]) => ({ meta: { message: 'Success', code: 200, status: 'success' }, data: rows });

const unit = (key: string, term: string, limit = 20): PaginatedAcquisitionUnit => ({
  key,
  searchTerm: term,
  limit,
  urlFor: (offset) => `https://ro.test/x?search=${term}&limit=${limit}&offset=${offset}`,
});

let root: string;
beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ro-resume-'));
});
afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

// -------------------------------------------------------- 1-6. readRaw

describe('storage.readRaw', () => {
  it('returns a previously written artifact verbatim', async () => {
    const storage = createFileStorage(root);
    const body = { key: 'district-andir', searchTerm: 'Andir', limit: 20, offsets: [0], pages: [], candidateIds: [] };

    await storage.writeRaw('district-andir', body);

    expect(await storage.readRaw('district-andir')).toEqual(body);
  });

  it('does not modify the artifact it reads', async () => {
    const storage = createFileStorage(root);
    await storage.writeRaw('district-andir', { searchTerm: 'Andir', limit: 20, offsets: [0], pages: [] });
    const file = path.join(root, artifactName('district-andir'));
    const before = await fsp.readFile(file, 'utf8');

    await storage.readRaw('district-andir');
    await storage.readRaw('district-andir');

    expect(await fsp.readFile(file, 'utf8')).toBe(before);
  });

  it('fails explicitly on a missing artifact — never an empty result', async () => {
    await expect(createFileStorage(root).readRaw('district-nope')).rejects.toThrow(MissingArtifactError);
  });

  it('fails explicitly on a malformed artifact', async () => {
    await fsp.writeFile(path.join(root, artifactName('district-bad')), '{ not json', 'utf8');

    await expect(createFileStorage(root).readRaw('district-bad')).rejects.toThrow(CorruptArtifactError);
  });

  it('is traversal-safe: a hostile unit key cannot escape the cache root', async () => {
    const storage = createFileStorage(root);
    await storage.writeRaw('../../escape', { searchTerm: 'x', limit: 20, offsets: [], pages: [] });

    // Written inside the root under a sanitised name, and read back by the same key.
    const entries = await fsp.readdir(root);
    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toContain('..');
    await expect(storage.readRaw('../../escape')).resolves.toBeDefined();
  });
});

// ---------------------------------------------- 6. empty vs missing

describe('a legitimately empty district is not a missing one', () => {
  it('accepts an artifact with zero rows and yields an empty pool, not an error', async () => {
    const storage = createFileStorage(root);
    // Exactly what the runner writes for an empty-search 404 (Astanaanyar).
    await storage.writeRaw('district-astanaanyar', {
      key: 'district-astanaanyar',
      searchTerm: 'Astanaanyar',
      limit: 20,
      offsets: [0],
      pages: [{ offset: 0, rows: [] }],
      candidateIds: [],
    });

    const units = await reconstructAcquiredUnits(storage, ['district-astanaanyar']);

    expect(units).toHaveLength(1);
    expect(units[0].rows).toEqual([]);
    expect(poolFrom(units)).toEqual([]);
  });

  it('a missing artifact for the same unit throws instead', async () => {
    await expect(reconstructAcquiredUnits(createFileStorage(root), ['district-astanaanyar'])).rejects.toThrow(
      MissingArtifactError,
    );
  });
});

// ------------------------------------------------- parseArtifact safety

describe('parseArtifact refuses anything it does not recognise', () => {
  it.each([
    ['a non-object', 'nope'],
    ['no searchTerm', { limit: 20, offsets: [], pages: [] }],
    ['no limit', { searchTerm: 'A', offsets: [], pages: [] }],
    ['no offsets', { searchTerm: 'A', limit: 20, pages: [] }],
    ['no pages', { searchTerm: 'A', limit: 20, offsets: [] }],
    ['a page without rows', { searchTerm: 'A', limit: 20, offsets: [0], pages: [{ offset: 0 }] }],
    ['a row without a numeric id', { searchTerm: 'A', limit: 20, offsets: [0], pages: [{ offset: 0, rows: [{ id: 'x' }] }] }],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseArtifact('district-x', raw)).toThrow(CorruptArtifactError);
  });

  it('deduplicates rows by id while reconstructing', () => {
    const parsed = parseArtifact('district-x', {
      searchTerm: 'X',
      limit: 20,
      offsets: [0, 20],
      pages: [
        { offset: 0, rows: [row(1, 'A', 'D'), row(2, 'B', 'D')] },
        { offset: 20, rows: [row(2, 'B-AGAIN', 'D'), row(3, 'C', 'D')] },
      ],
    });

    expect(parsed.rows.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(parsed.rows.find((r) => r.id === 2)!.subdistrict_name).toBe('B');
  });
});

// -------------------------------------- 7-10. the actual resume scenario

describe('resumed run reconstructs the FULL pool', () => {
  const villages: MassularVillage[] = [
    { code: 'a', name: 'Va', postalCode: '40294', districtName: 'A', cityName: 'Kota Bandung', provinceName: 'Jawa Barat' },
    { code: 'b', name: 'Vb', postalCode: '40294', districtName: 'B', cityName: 'Kota Bandung', provinceName: 'Jawa Barat' },
    { code: 'c', name: 'Vc', postalCode: '40294', districtName: 'C', cityName: 'Kota Bandung', provinceName: 'Jawa Barat' },
    { code: 'd', name: 'Vd', postalCode: '40294', districtName: 'D', cityName: 'Kota Bandung', provinceName: 'Jawa Barat' },
    { code: 'e', name: 'Ve', postalCode: '40294', districtName: 'E', cityName: 'Kota Bandung', provinceName: 'Jawa Barat' },
  ];
  const all = ['A', 'B', 'C', 'D', 'E'].map((d) => unit(`district-${d.toLowerCase()}`, d));

  /** Run A,B,C first; then resume and acquire D,E. */
  async function runThenResume() {
    const storage = createFileStorage(root);
    const first = jest.fn().mockImplementation(async (url: string) => {
      const term = new URL(url).searchParams.get('search')!;
      return { status: 200, body: ok([row(term.charCodeAt(0), `V${term.toLowerCase()}`, term)]) };
    });
    await runPaginatedAcquisition(all.slice(0, 3), first as never, storage, { acquisitionId: 'acq' });

    const second = jest.fn().mockImplementation(async (url: string) => {
      const term = new URL(url).searchParams.get('search')!;
      return { status: 200, body: ok([row(term.charCodeAt(0), `V${term.toLowerCase()}`, term)]) };
    });
    const result = await runPaginatedAcquisition(all, second as never, storage, { acquisitionId: 'acq' });
    return { storage, result, second };
  }

  it('A+B+C from the checkpoint plus D+E from this run', async () => {
    const { storage, result, second } = await runThenResume();

    expect(result.unitsSkipped).toBe(3);
    expect(result.unitsCompleted).toBe(2);
    expect(second).toHaveBeenCalledTimes(2); // only D and E were requested

    const units = await reconstructAcquiredUnits(storage, result.checkpoint.completedUnits);
    expect(units.map((u) => u.key)).toEqual([
      'district-a', 'district-b', 'district-c', 'district-d', 'district-e',
    ]);
    expect(poolFrom(units)).toHaveLength(5);
  });

  it('result.acquired alone is NOT sufficient — this is the bug being fixed', async () => {
    const { result } = await runThenResume();

    // Only the current run's units. Mapping from this drops A, B and C.
    expect(result.acquired.map((u) => u.key)).toEqual(['district-d', 'district-e']);
    expect(poolFrom(result.acquired)).toHaveLength(2);

    const partial = mapVillages(villages, poolFrom(result.acquired));
    expect(partial.matched).toBe(2);
    expect(partial.notFound).toBe(3);
  });

  it('the reconstructed pool maps all five villages', async () => {
    const { storage, result } = await runThenResume();

    const units = await reconstructAcquiredUnits(storage, result.checkpoint.completedUnits);
    const full = mapVillages(villages, poolFrom(units));

    expect(full.matched).toBe(5);
    expect(full.notFound).toBe(0);
  });

  it('reconstruction is deterministic and writes nothing', async () => {
    const { storage, result } = await runThenResume();
    const before = (await fsp.readdir(root)).sort();
    const cpBefore = await fsp.readFile(path.join(root, CHECKPOINT_FILENAME), 'utf8');

    const a = await reconstructAcquiredUnits(storage, result.checkpoint.completedUnits);
    const b = await reconstructAcquiredUnits(storage, result.checkpoint.completedUnits);

    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect((await fsp.readdir(root)).sort()).toEqual(before);
    expect(await fsp.readFile(path.join(root, CHECKPOINT_FILENAME), 'utf8')).toBe(cpBefore);
  });

  it('one missing artifact prevents the whole reconstruction', async () => {
    const { storage, result } = await runThenResume();
    await fsp.rm(path.join(root, artifactName('district-b')));

    await expect(reconstructAcquiredUnits(storage, result.checkpoint.completedUnits)).rejects.toThrow(
      MissingArtifactError,
    );
  });
});

// --------------------------------- 10. the REAL PAXELBOX-60 artifacts

describe('the real PAXELBOX-60 cache (READ-ONLY)', () => {
  const REAL_ROOT = path.join('prisma', 'data', 'rajaongkir-cache', 'full-kota-bandung');
  const EXPECTED = [
    'district-andir',
    'district-antapani',
    'district-arcamanik',
    'district-astanaanyar',
    'district-babakan-ciparay',
  ];

  const present = async () => {
    try {
      await fsp.access(path.join(REAL_ROOT, CHECKPOINT_FILENAME));
      return true;
    } catch {
      return false;
    }
  };

  it('resolves all five completed units through the storage abstraction', async () => {
    if (!(await present())) return; // cache is gitignored; skip where absent
    const storage = createFileStorage(REAL_ROOT);
    const cp = JSON.parse(await fsp.readFile(path.join(REAL_ROOT, CHECKPOINT_FILENAME), 'utf8'));

    // A SUBSET check, not equality: the real checkpoint grows as acquisition
    // advances, and pinning it to a snapshot would fail on every future run
    // without indicating anything wrong.
    for (const key of EXPECTED) expect(cp.completedUnits).toContain(key);

    const units = await reconstructAcquiredUnits(storage, cp.completedUnits);
    expect(units.map((u) => u.key)).toEqual(cp.completedUnits);
    for (const key of EXPECTED) expect(units.map((u) => u.key)).toContain(key);
    // Astanaanyar is a legitimate zero-row district and must survive.
    expect(units.find((u) => u.key === 'district-astanaanyar')!.rows).toEqual([]);
    expect(poolFrom(units).length).toBeGreaterThan(0);
  });

  it('reading the real cache leaves every file byte-identical', async () => {
    if (!(await present())) return;
    const before = new Map<string, string>();
    for (const f of await fsp.readdir(REAL_ROOT)) {
      before.set(f, await fsp.readFile(path.join(REAL_ROOT, f), 'utf8'));
    }

    const storage = createFileStorage(REAL_ROOT);
    const cp = JSON.parse(await fsp.readFile(path.join(REAL_ROOT, CHECKPOINT_FILENAME), 'utf8'));
    await reconstructAcquiredUnits(storage, cp.completedUnits);

    for (const [f, content] of before) {
      expect(await fsp.readFile(path.join(REAL_ROOT, f), 'utf8')).toBe(content);
    }
  });

  it('no API key appears in anything reconstruction returns', async () => {
    if (!(await present())) return;
    const storage = createFileStorage(REAL_ROOT);
    const cp = JSON.parse(await fsp.readFile(path.join(REAL_ROOT, CHECKPOINT_FILENAME), 'utf8'));
    const units = await reconstructAcquiredUnits(storage, cp.completedUnits);

    const dumped = JSON.stringify(units);
    expect(dumped).not.toMatch(/api[_-]?key/i);
    expect(dumped).not.toMatch(/authorization/i);
    // Artifacts store no URLs, so no credential can ride along in one.
    expect(dumped).not.toContain('http');
  });
});
