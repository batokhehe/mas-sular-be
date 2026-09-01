import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  CHECKPOINT_VERSION,
  emptyCheckpoint,
  runPaginatedAcquisition,
  type PaginatedAcquisitionUnit,
  type RajaOngkirDestinationRaw,
} from '../../prisma/tools/rajaongkir-acquisition';
import { buildAcquisitionPlan } from '../../prisma/tools/rajaongkir-plan';
import { mapVillages, type MassularVillage } from '../../prisma/tools/rajaongkir-village-map';
import { poolFrom } from '../../prisma/tools/rajaongkir-acquisition';
import {
  artifactName,
  CHECKPOINT_FILENAME,
  CorruptCheckpointError,
  createFileStorage,
} from '../../prisma/tools/rajaongkir-storage';

/**
 * PAXELBOX-58. The real filesystem storage, exercised in a per-test temp
 * directory. Nothing is written under prisma/data/, and no acquisition runs.
 *
 * The property under test is that the checkpoint is trustworthy: it is written
 * atomically, it is only believed when it is intact and of the current version,
 * and it never claims a unit whose artifact is not already durable.
 */

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ro-cache-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const readCheckpointFile = async () => JSON.parse(await fs.readFile(path.join(root, CHECKPOINT_FILENAME), 'utf8'));

describe('artifact naming', () => {
  it('is deterministic', () => {
    expect(artifactName('district-gedebage')).toBe(artifactName('district-gedebage'));
  });

  it('is traversal-safe', () => {
    const name = artifactName('../../etc/passwd');
    expect(name).not.toContain('..');
    expect(name).not.toContain('/');
    expect(name).not.toContain('\\');
    expect(name.startsWith('.')).toBe(false);
  });

  it('keeps units distinct even when their sanitised names collide', () => {
    // Both collapse to the same safe stem; the digest of the ORIGINAL key separates them.
    expect(artifactName('district/gedebage')).not.toBe(artifactName('district:gedebage'));
  });
});

describe('raw artifacts', () => {
  it('writes the body as readable JSON and returns the filename', async () => {
    const storage = createFileStorage(root);
    const name = await storage.writeRaw('district-gedebage', { key: 'district-gedebage', pages: [] });

    const written = JSON.parse(await fs.readFile(path.join(root, name), 'utf8'));
    expect(written).toEqual({ key: 'district-gedebage', pages: [] });
  });

  it('creates the cache directory on first write, not on import', async () => {
    const nested = path.join(root, 'does', 'not', 'exist', 'yet');
    await expect(fs.stat(nested)).rejects.toThrow();

    await createFileStorage(nested).writeRaw('u', { ok: true });

    expect((await fs.stat(nested)).isDirectory()).toBe(true);
  });
});

describe('checkpoint', () => {
  it('returns null for a fresh run', async () => {
    await expect(createFileStorage(root).readCheckpoint()).resolves.toBeNull();
  });

  it('round-trips a complete snapshot', async () => {
    const storage = createFileStorage(root);
    const cp = { ...emptyCheckpoint('acq-58', '2026-09-01T00:00:00.000Z'), completedUnits: ['district-a'] };

    await storage.writeCheckpoint(cp);

    expect(await storage.readCheckpoint()).toEqual(cp);
    expect(await readCheckpointFile()).toEqual(cp);
  });

  it('leaves no temp files behind after an atomic write', async () => {
    const storage = createFileStorage(root);
    await storage.writeCheckpoint(emptyCheckpoint('acq-58', '2026-09-01T00:00:00.000Z'));

    const entries = await fs.readdir(root);
    expect(entries).toEqual([CHECKPOINT_FILENAME]);
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false);
  });

  it('fails closed on a corrupt checkpoint rather than silently re-acquiring', async () => {
    await fs.writeFile(path.join(root, CHECKPOINT_FILENAME), '{ this is not json', 'utf8');

    await expect(createFileStorage(root).readCheckpoint()).rejects.toThrow(CorruptCheckpointError);
  });

  it('fails closed on a version mismatch', async () => {
    const stale = { ...emptyCheckpoint('acq-58', '2026-09-01T00:00:00.000Z'), version: CHECKPOINT_VERSION + 1 };
    await fs.writeFile(path.join(root, CHECKPOINT_FILENAME), JSON.stringify(stale), 'utf8');

    await expect(createFileStorage(root).readCheckpoint()).rejects.toThrow(/CHECKPOINT_VERSION/);
  });

  it('fails closed on a structurally invalid checkpoint', async () => {
    await fs.writeFile(path.join(root, CHECKPOINT_FILENAME), JSON.stringify({ version: CHECKPOINT_VERSION }), 'utf8');

    await expect(createFileStorage(root).readCheckpoint()).rejects.toThrow(CorruptCheckpointError);
  });

  it('can be opted out of fail-closed, treating a corrupt file as a fresh run', async () => {
    await fs.writeFile(path.join(root, CHECKPOINT_FILENAME), 'garbage', 'utf8');

    const storage = createFileStorage(root, { failClosedOnCorrupt: false });
    await expect(storage.readCheckpoint()).resolves.toBeNull();
  });
});

// ----------------------------------------------- runner + real storage

const row = (id: number, subdistrict: string): RajaOngkirDestinationRaw => ({
  id,
  label: `${subdistrict}, GEDEBAGE, BANDUNG, JAWA BARAT, 40294`,
  province_name: 'JAWA BARAT',
  city_name: 'BANDUNG',
  district_name: 'GEDEBAGE',
  subdistrict_name: subdistrict,
  zip_code: '40294',
});
const ok = (rows: RajaOngkirDestinationRaw[]) => ({ meta: { message: 'Success', code: 200, status: 'success' }, data: rows });

const unit = (key: string, limit = 2): PaginatedAcquisitionUnit => ({
  key,
  searchTerm: key,
  limit,
  urlFor: (offset) => `https://ro.test/x?search=${key}&limit=${limit}&offset=${offset}`,
});

describe('runner against real filesystem storage', () => {
  it('persists the artifact and the checkpoint for a completed run', async () => {
    const storage = createFileStorage(root);
    const transport = jest.fn().mockResolvedValue({ status: 200, body: ok([row(1, 'A')]) });

    const res = await runPaginatedAcquisition([unit('district-a')], transport as never, storage, {
      acquisitionId: 'acq-58',
    });

    expect(res.stopped).toBe(false);
    expect((await readCheckpointFile()).completedUnits).toEqual(['district-a']);
    const artifact = JSON.parse(await fs.readFile(path.join(root, artifactName('district-a')), 'utf8'));
    expect(artifact.candidateIds).toEqual([1]);
  });

  it('a failure before any artifact leaves no artifact and no completed unit', async () => {
    const storage = createFileStorage(root);
    const transport = jest.fn().mockResolvedValue({ status: 429, body: { meta: { code: 429, message: 'Daily limit exceeded' }, data: null } });

    const res = await runPaginatedAcquisition([unit('district-a')], transport as never, storage, {
      acquisitionId: 'acq-58',
    });

    expect(res.failure?.category).toBe('RATE_LIMITED');
    const entries = await fs.readdir(root);
    expect(entries).toEqual([CHECKPOINT_FILENAME]); // checkpoint records the failure, no artifact
    expect((await readCheckpointFile()).completedUnits).toEqual([]);
  });

  it('a failure AFTER an earlier unit keeps that unit resumable and re-runs only the rest', async () => {
    const storage = createFileStorage(root);
    const first = jest
      .fn()
      .mockResolvedValueOnce({ status: 200, body: ok([row(1, 'A')]) })
      .mockResolvedValueOnce({ status: 429, body: { meta: { code: 429, message: 'Daily limit exceeded' }, data: null } });

    await runPaginatedAcquisition([unit('district-a'), unit('district-b')], first as never, storage, {
      acquisitionId: 'acq-58',
    });
    expect((await readCheckpointFile()).completedUnits).toEqual(['district-a']);

    // Resume with a fresh storage handle — proves state came off disk.
    const resumed = createFileStorage(root);
    const second = jest.fn().mockResolvedValue({ status: 200, body: ok([row(2, 'B')]) });
    const res2 = await runPaginatedAcquisition([unit('district-a'), unit('district-b')], second as never, resumed, {
      acquisitionId: 'acq-58',
    });

    expect(res2.unitsSkipped).toBe(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect((await readCheckpointFile()).completedUnits).toEqual(['district-a', 'district-b']);
  });

  it('a checkpoint write failure after the artifact does not claim the unit', async () => {
    const storage = createFileStorage(root);
    const boom = new Error('disk full');
    jest.spyOn(storage, 'writeCheckpoint').mockRejectedValueOnce(boom);
    const transport = jest.fn().mockResolvedValue({ status: 200, body: ok([row(1, 'A')]) });

    await expect(
      runPaginatedAcquisition([unit('district-a')], transport as never, storage, { acquisitionId: 'acq-58' }),
    ).rejects.toThrow('disk full');

    // The artifact exists but nothing claims it, so a resume re-acquires the unit.
    expect(await fs.readdir(root)).toEqual([artifactName('district-a')]);
  });
});

// ------------------------------------- end-to-end, offline: plan -> mapper

/**
 * The whole execution surface wired together with an injected transport and a
 * REAL filesystem storage: plan -> runner -> artifacts -> pool -> mapper.
 * Nothing touches the network, and nothing touches Prisma — the chain ends at a
 * reviewable report, which is exactly where PAXELBOX-58 is meant to stop.
 */
describe('plan -> runner -> storage -> mapper', () => {
  const jb = { cityName: 'Kota Bandung', provinceName: 'Jawa Barat' };
  const villages: MassularVillage[] = [
    { code: 'v-match', name: 'Cisaranten Kidul', postalCode: '40294', districtName: 'Gedebage', ...jb },
    { code: 'v-notfound', name: 'Rancabolang', postalCode: '40294', districtName: 'Gedebage', ...jb },
    { code: 'v-ambiguous', name: 'Kembar', postalCode: '40295', districtName: 'Gedebage', ...jb },
    { code: 'v-review', name: 'Nozip', postalCode: null, districtName: 'Gedebage', ...jb },
  ];

  const ro = (id: number, subdistrict: string, zip: string | null): RajaOngkirDestinationRaw => ({
    id,
    label: `${subdistrict}, GEDEBAGE, BANDUNG, JAWA BARAT, ${zip ?? ''}`,
    province_name: 'JAWA BARAT',
    city_name: 'BANDUNG',
    district_name: 'GEDEBAGE',
    subdistrict_name: subdistrict,
    zip_code: zip,
  });

  it('produces every matcher outcome from one acquired pool, writing nothing to a database', async () => {
    const storage = createFileStorage(root);
    // One district unit; the pool deliberately contains no "RANCABOLANG".
    const plan = buildAcquisitionPlan(villages, { limit: 20 });
    expect(plan.units).toHaveLength(1);
    expect(plan.units[0].searchTerm).toBe('Gedebage');

    const transport = jest.fn().mockResolvedValue({
      status: 200,
      body: ok([
        ro(4957, 'CISARANTEN KIDUL', '40294'),
        ro(5001, 'KEMBAR', '40295'),
        ro(5002, 'KEMBAR', '40295'), // same names AND zip -> genuine tie
        ro(5003, 'NOZIP', '40296'),
      ]),
    });

    const res = await runPaginatedAcquisition(plan.units, transport as never, storage, { acquisitionId: 'acq-58' });
    expect(res.stopped).toBe(false);

    const report = mapVillages(villages, poolFrom(res.acquired));
    const byCode = Object.fromEntries(report.matches.map((m) => [m.code, m.outcome]));

    expect(byCode['v-match']).toBe('MATCHED');
    expect(byCode['v-notfound']).toBe('NOT_FOUND');
    expect(byCode['v-ambiguous']).toBe('AMBIGUOUS');
    expect(byCode['v-review']).toBe('REVIEW_REQUIRED');

    // AMBIGUOUS blocks the whole write — never resolved by picking one id.
    expect(report.safeToApply).toBe(false);
    expect(report.blockers.join(' ')).toMatch(/matched more than one/);

    // The artifact is on disk and reviewable; no DB was involved.
    const artifact = JSON.parse(await fs.readFile(path.join(root, artifactName(plan.units[0].key)), 'utf8'));
    expect(artifact.searchTerm).toBe('Gedebage');
    expect(artifact.candidateIds).toEqual([4957, 5001, 5002, 5003]);
  });
});
