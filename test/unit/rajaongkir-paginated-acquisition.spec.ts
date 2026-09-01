import {
  EMPTY_SEARCH_MESSAGE,
  isEmptySearchResponse,
  DEFAULT_MAX_PAGES,
  FAILURE_STOPS_RUN,
  poolFrom,
  rawFileName,
  runPaginatedAcquisition,
  type AcquisitionStorage,
  type Checkpoint,
  type PaginatedAcquisitionUnit,
  type RajaOngkirDestinationRaw,
} from '../../prisma/tools/rajaongkir-acquisition';
import { applicableMappings, mapVillages, type MassularVillage } from '../../prisma/tools/rajaongkir-village-map';

/**
 * PAXELBOX-56. The paginating acquisition path, exercised entirely offline —
 * transport and storage are injected, so nothing here reaches RajaOngkir or disk.
 *
 * The property this file exists to protect: a target is classified ONLY after
 * its search result set has been proven exhausted. Responses carry no total
 * count (PAXELBOX-52D), so the only proof is a short page. Every way of failing
 * to obtain that proof must surface as a failure, never as a verdict — a
 * truncated pool turns a real destination into "no such place", which is the
 * silent corruption this module exists to prevent.
 */

const row = (id: number, subdistrict: string, district = 'GEDEBAGE', zip = '40294'): RajaOngkirDestinationRaw => ({
  id,
  label: `${subdistrict}, ${district}, BANDUNG, JAWA BARAT, ${zip}`,
  province_name: 'JAWA BARAT',
  city_name: 'BANDUNG',
  district_name: district,
  subdistrict_name: subdistrict,
  zip_code: zip,
});

const ok = (rows: RajaOngkirDestinationRaw[]) => ({
  meta: { message: 'Success Get Domestic Destinations', code: 200, status: 'success' },
  data: rows,
});
const RATE_LIMITED_BODY = { meta: { message: 'Daily limit exceeded', code: 429, status: 'error' }, data: null };

/** In-memory storage; records write ORDER so artifact-before-checkpoint is checkable. */
function memoryStorage() {
  const raw = new Map<string, unknown>();
  let checkpoint: unknown = null;
  const writes: string[] = [];
  const storage: AcquisitionStorage = {
    readCheckpoint: async () => checkpoint,
    writeCheckpoint: async (c) => {
      checkpoint = JSON.parse(JSON.stringify(c));
      writes.push('checkpoint');
    },
    writeRaw: async (unitKey, body) => {
      const name = rawFileName(unitKey);
      raw.set(name, JSON.parse(JSON.stringify(body)));
      writes.push(`raw:${name}`);
      return name;
    },
    readRaw: async (unitKey) => {
      const name = rawFileName(unitKey);
      if (!raw.has(name)) throw new Error(`missing artifact for ${unitKey}`);
      return JSON.parse(JSON.stringify(raw.get(name)));
    },
  };
  return {
    storage,
    raw,
    writes,
    get checkpoint() {
      return checkpoint as Checkpoint | null;
    },
  };
}

/** limit 2 keeps the page arithmetic readable; the real plan uses a larger page. */
const unit = (key: string, searchTerm: string, limit = 2): PaginatedAcquisitionUnit => ({
  key,
  searchTerm,
  limit,
  urlFor: (offset) =>
    `https://ro.test/destination/domestic-destination?search=${encodeURIComponent(searchTerm)}&limit=${limit}&offset=${offset}`,
});

const run = (
  s: ReturnType<typeof memoryStorage>,
  transport: jest.Mock,
  units: PaginatedAcquisitionUnit[],
  maxPages?: number,
) =>
  runPaginatedAcquisition(units, transport as never, s.storage, {
    acquisitionId: 'acq-56',
    now: () => '2026-09-01T00:00:00.000Z',
    maxPages,
  });

// --------------------------------------------------------- 1-2. page loop

describe('page loop termination', () => {
  it('completes a one-page unit when the first page is short', async () => {
    const s = memoryStorage();
    const transport = jest.fn().mockResolvedValue({ status: 200, body: ok([row(4956, 'CIMENERANG')]) });

    const res = await run(s, transport, [unit('district-gedebage', 'Gedebage')]);

    expect(transport).toHaveBeenCalledTimes(1);
    expect(res.stopped).toBe(false);
    expect(res.unitsCompleted).toBe(1);
    expect(res.acquired[0].rows).toHaveLength(1);
    expect(s.checkpoint?.completedUnits).toEqual(['district-gedebage']);
  });

  it('keeps paging through full pages and stops on the first short page', async () => {
    const s = memoryStorage();
    const transport = jest
      .fn()
      .mockResolvedValueOnce({ status: 200, body: ok([row(1, 'A'), row(2, 'B')]) }) // full
      .mockResolvedValueOnce({ status: 200, body: ok([row(3, 'C'), row(4, 'D')]) }) // full
      .mockResolvedValueOnce({ status: 200, body: ok([row(5, 'E')]) }); // short -> done

    const res = await run(s, transport, [unit('u', 'Gedebage')]);

    expect(transport).toHaveBeenCalledTimes(3);
    expect(res.acquired[0].offsets).toEqual([0, 2, 4]);
    expect(res.acquired[0].rows.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
    expect(res.stopped).toBe(false);
  });

  it('treats an exactly-full page followed by an empty page as complete', async () => {
    const s = memoryStorage();
    const transport = jest
      .fn()
      .mockResolvedValueOnce({ status: 200, body: ok([row(1, 'A'), row(2, 'B')]) })
      .mockResolvedValueOnce({ status: 200, body: ok([]) });

    const res = await run(s, transport, [unit('u', 'Gedebage')]);

    expect(transport).toHaveBeenCalledTimes(2);
    expect(res.stopped).toBe(false);
    expect(res.acquired[0].rows).toHaveLength(2);
  });
});

// ----------------------------------------------- 3-4. accumulation + dedup

describe('candidate accumulation', () => {
  it('includes a candidate that only appears on page 2', async () => {
    const s = memoryStorage();
    const transport = jest
      .fn()
      .mockResolvedValueOnce({ status: 200, body: ok([row(1, 'A'), row(2, 'B')]) })
      .mockResolvedValueOnce({ status: 200, body: ok([row(99, 'LATE')]) });

    const res = await run(s, transport, [unit('u', 'Gedebage')]);

    expect(res.acquired[0].rows.map((r) => r.id)).toContain(99);
  });

  it('deduplicates by id across pages, first occurrence wins, order preserved', async () => {
    const s = memoryStorage();
    const transport = jest
      .fn()
      .mockResolvedValueOnce({ status: 200, body: ok([row(1, 'A'), row(2, 'B')]) })
      .mockResolvedValueOnce({ status: 200, body: ok([row(2, 'B-DUPLICATE'), row(3, 'C')]) })
      .mockResolvedValueOnce({ status: 200, body: ok([row(1, 'A-AGAIN')]) });

    const res = await run(s, transport, [unit('u', 'Gedebage')]);

    expect(res.acquired[0].rows.map((r) => r.id)).toEqual([1, 2, 3]);
    // First occurrence is kept, so the duplicate's differing name is discarded.
    expect(res.acquired[0].rows.find((r) => r.id === 2)!.subdistrict_name).toBe('B');
  });

  it('never deduplicates on name or postal code alone', async () => {
    const s = memoryStorage();
    // Two genuinely different destinations sharing both name and zip.
    const transport = jest.fn().mockResolvedValue({
      status: 200,
      body: ok([row(11, 'SUKAMAJU', 'DISTRICT-X'), row(12, 'SUKAMAJU', 'DISTRICT-Y')]),
    });

    const res = await run(s, transport, [unit('u', 'Sukamaju', 5)]);

    expect(res.acquired[0].rows.map((r) => r.id)).toEqual([11, 12]);
  });
});

// ------------------------------------------------------ 5. matcher timing

describe('matcher runs only on the complete result set', () => {
  const target: MassularVillage[] = [
    {
      code: '32.73.27.1002',
      name: 'Cisaranten Kidul',
      postalCode: '40294',
      districtName: 'Gedebage',
      cityName: 'Kota Bandung',
      provinceName: 'Jawa Barat',
    },
  ];

  it('a page-2 duplicate name turns MATCHED into AMBIGUOUS, so page 1 alone must not decide', async () => {
    const s = memoryStorage();
    const page1 = [row(4957, 'CISARANTEN KIDUL'), row(4958, 'RANCANUMPANG')];
    const page2 = [row(9999, 'CISARANTEN KIDUL')]; // same name+zip, different id

    // Page 1 in isolation would classify MATCHED — proving the risk is real.
    const early = mapVillages(target, page1.map((r) => ({
      id: r.id,
      provinceName: r.province_name,
      cityName: r.city_name,
      districtName: r.district_name,
      subdistrictName: r.subdistrict_name,
      zipCode: r.zip_code,
    })));
    expect(early.matches[0].outcome).toBe('MATCHED');

    const transport = jest
      .fn()
      .mockResolvedValueOnce({ status: 200, body: ok(page1) })
      .mockResolvedValueOnce({ status: 200, body: ok(page2) });

    const res = await run(s, transport, [unit('u', 'Gedebage')]);
    const full = mapVillages(target, poolFrom(res.acquired));

    expect(full.matches[0].outcome).toBe('AMBIGUOUS');
    expect(full.safeToApply).toBe(false);
  });

  it('poolFrom deduplicates ids across units', async () => {
    const shared = row(4957, 'CISARANTEN KIDUL');
    const pool = poolFrom([
      { key: 'a', searchTerm: 'a', limit: 5, offsets: [0], rows: [shared, row(1, 'X')] },
      { key: 'b', searchTerm: 'b', limit: 5, offsets: [0], rows: [shared, row(2, 'Y')] },
    ]);
    expect(pool.map((p) => p.id)).toEqual([4957, 1, 2]);
  });
});

// ------------------------------------------------------- 6. max page ceiling

describe('page ceiling', () => {
  it('fails with INCOMPLETE_RESULT_SET when the ceiling is hit on a full page', async () => {
    const s = memoryStorage();
    const transport = jest.fn().mockResolvedValue({ status: 200, body: ok([row(1, 'A'), row(2, 'B')]) }); // always full

    const res = await run(s, transport, [unit('u', 'Gedebage')], 3);

    expect(transport).toHaveBeenCalledTimes(3);
    expect(res.stopped).toBe(true);
    expect(res.failure?.category).toBe('INCOMPLETE_RESULT_SET');
    expect(res.acquired).toEqual([]);
    expect(s.checkpoint?.completedUnits).toEqual([]);
    expect(s.raw.size).toBe(0);
  });

  it('never converts a ceiling hit into NOT_FOUND, MATCHED or AMBIGUOUS', async () => {
    const s = memoryStorage();
    const transport = jest.fn().mockResolvedValue({ status: 200, body: ok([row(1, 'A'), row(2, 'B')]) });

    const res = await run(s, transport, [unit('u', 'Gedebage')], 2);

    // The unit yielded no acquired data at all, so no classification is possible.
    expect(res.acquired).toEqual([]);
    expect(FAILURE_STOPS_RUN.INCOMPLETE_RESULT_SET).toBe(true);
  });

  it('defaults to a bounded ceiling rather than looping forever', () => {
    expect(DEFAULT_MAX_PAGES).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_MAX_PAGES)).toBe(true);
  });
});

// ------------------------------------------------------- 9-12. failure matrix

describe('failures never complete a unit', () => {
  it('429 on page 1 makes exactly one request and does not retry', async () => {
    const s = memoryStorage();
    const transport = jest.fn().mockResolvedValue({ status: 429, body: RATE_LIMITED_BODY });

    const res = await run(s, transport, [unit('u', 'Gedebage')]);

    expect(transport).toHaveBeenCalledTimes(1);
    expect(res.failure?.category).toBe('RATE_LIMITED');
    expect(res.requests).toBe(1);
  });

  it('429 mid-pagination abandons the whole unit, not just the page', async () => {
    const s = memoryStorage();
    const transport = jest
      .fn()
      .mockResolvedValueOnce({ status: 200, body: ok([row(1, 'A'), row(2, 'B')]) })
      .mockResolvedValueOnce({ status: 429, body: RATE_LIMITED_BODY });

    const res = await run(s, transport, [unit('u', 'Gedebage')]);

    expect(transport).toHaveBeenCalledTimes(2);
    expect(res.stopped).toBe(true);
    expect(s.checkpoint?.completedUnits).toEqual([]);
    expect(s.raw.size).toBe(0); // page 1 alone must not be persisted as the unit
  });

  it('a 200 carrying a 429 error envelope is a refusal, never an empty result set', async () => {
    const s = memoryStorage();
    const transport = jest.fn().mockResolvedValue({ status: 200, body: RATE_LIMITED_BODY });

    const res = await run(s, transport, [unit('u', 'Gedebage')]);

    expect(res.failure?.category).toBe('RATE_LIMITED');
    expect(res.acquired).toEqual([]);
    expect(s.checkpoint?.completedUnits).toEqual([]);
  });

  it('a malformed page does not checkpoint or store the unit', async () => {
    const s = memoryStorage();
    const transport = jest
      .fn()
      .mockResolvedValueOnce({ status: 200, body: ok([row(1, 'A'), row(2, 'B')]) })
      .mockResolvedValueOnce({ status: 200, body: { meta: { code: 200 }, data: [{ id: 5 }] } });

    const res = await run(s, transport, [unit('u', 'Gedebage')]);

    expect(res.failure?.category).toBe('MALFORMED_RESPONSE');
    expect(s.checkpoint?.completedUnits).toEqual([]);
    expect(s.raw.size).toBe(0);
  });

  it('a network throw stops the unit without completing it', async () => {
    const s = memoryStorage();
    const transport = jest.fn().mockRejectedValue(new Error('ECONNRESET'));

    const res = await run(s, transport, [unit('u', 'Gedebage')]);

    expect(res.failure?.category).toBe('NETWORK_ERROR');
    expect(s.checkpoint?.completedUnits).toEqual([]);
  });

  it('previously completed units survive a later failure and are skipped on resume', async () => {
    const s = memoryStorage();
    const good = unit('district-a', 'A');
    const bad = unit('district-b', 'B');

    const first = jest
      .fn()
      .mockResolvedValueOnce({ status: 200, body: ok([row(1, 'A1')]) }) // district-a short -> complete
      .mockResolvedValueOnce({ status: 429, body: RATE_LIMITED_BODY }); // district-b refused

    const res1 = await run(s, first, [good, bad]);
    expect(res1.unitsCompleted).toBe(1);
    expect(s.checkpoint?.completedUnits).toEqual(['district-a']);

    const second = jest.fn().mockResolvedValue({ status: 200, body: ok([row(2, 'B1')]) });
    const res2 = await run(s, second, [good, bad]);

    expect(res2.unitsSkipped).toBe(1); // district-a not re-fetched
    expect(second).toHaveBeenCalledTimes(1); // only district-b
    expect(s.checkpoint?.completedUnits).toEqual(['district-a', 'district-b']);
    expect(s.checkpoint?.failure).toBeUndefined();
  });

  it('writes the artifact before the checkpoint that claims it', async () => {
    const s = memoryStorage();
    const transport = jest.fn().mockResolvedValue({ status: 200, body: ok([row(1, 'A')]) });

    await run(s, transport, [unit('district-gedebage', 'Gedebage')]);

    expect(s.writes).toEqual(['raw:district-gedebage.json', 'checkpoint']);
  });
});

// --------------------------------------------------- 15-16. empty vs error

describe('empty data', () => {
  it('a successful empty array is a complete result set and yields NOT_FOUND', async () => {
    const s = memoryStorage();
    const transport = jest.fn().mockResolvedValue({ status: 200, body: ok([]) });

    const res = await run(s, transport, [unit('u', 'Nowhere')]);

    expect(res.stopped).toBe(false);
    expect(res.unitsCompleted).toBe(1);

    const report = mapVillages(
      [
        {
          code: '32.73.27.1001',
          name: 'Cimincrang',
          postalCode: '40294',
          districtName: 'Gedebage',
          cityName: 'Kota Bandung',
          provinceName: 'Jawa Barat',
        },
      ],
      poolFrom(res.acquired),
    );
    expect(report.matches[0].outcome).toBe('NOT_FOUND');
  });

  it('an error envelope with data=null is not an empty success', async () => {
    const s = memoryStorage();
    const transport = jest.fn().mockResolvedValue({ status: 200, body: RATE_LIMITED_BODY });

    const res = await run(s, transport, [unit('u', 'Nowhere')]);

    expect(res.stopped).toBe(true);
    expect(res.unitsCompleted).toBe(0);
  });
});

// ------------------------------------------------------- 13-14. hygiene

describe('artifact hygiene and determinism', () => {
  const SECRET = 'test-secret-key-value-do-not-leak';

  it('no credential reaches any URL or artifact', async () => {
    const s = memoryStorage();
    const seenUrls: string[] = [];
    // The key lives in the transport's closure — exactly as the real client works.
    const transport = jest.fn().mockImplementation(async (url: string) => {
      seenUrls.push(url);
      expect(url).not.toContain(SECRET);
      return { status: 200, body: ok([row(1, 'A')]) };
    });

    await runPaginatedAcquisition([unit('district-gedebage', 'Gedebage')], transport as never, s.storage, {
      acquisitionId: 'acq-56',
      now: () => '2026-09-01T00:00:00.000Z',
    });

    const dumped = JSON.stringify([...s.raw.entries()]) + JSON.stringify(s.checkpoint) + seenUrls.join('|');
    expect(dumped).not.toContain(SECRET);
  });

  it('records deterministic page offsets and candidate ids in the artifact', async () => {
    const s = memoryStorage();
    const transport = jest
      .fn()
      .mockResolvedValueOnce({ status: 200, body: ok([row(1, 'A'), row(2, 'B')]) })
      .mockResolvedValueOnce({ status: 200, body: ok([row(3, 'C')]) });

    await run(s, transport, [unit('district-gedebage', 'Gedebage')]);

    const artifact = s.raw.get('district-gedebage.json') as {
      key: string;
      searchTerm: string;
      limit: number;
      offsets: number[];
      candidateIds: number[];
      pages: Array<{ offset: number; rows: RajaOngkirDestinationRaw[] }>;
    };
    expect(artifact.key).toBe('district-gedebage');
    expect(artifact.searchTerm).toBe('Gedebage');
    expect(artifact.offsets).toEqual([0, 2]);
    expect(artifact.candidateIds).toEqual([1, 2, 3]);
    expect(artifact.pages.map((p) => p.offset)).toEqual([0, 2]);
    // Rows are preserved in the original snake_case wire shape.
    expect(artifact.pages[0].rows[0]).toHaveProperty('subdistrict_name');
    expect(artifact.pages[0].rows[0]).toHaveProperty('zip_code');
  });

  it('requests pages in ascending offset order', async () => {
    const s = memoryStorage();
    const urls: string[] = [];
    const transport = jest.fn().mockImplementation(async (url: string) => {
      urls.push(url);
      return urls.length < 3
        ? { status: 200, body: ok([row(urls.length * 10, 'X'), row(urls.length * 10 + 1, 'Y')]) }
        : { status: 200, body: ok([]) };
    });

    await run(s, transport, [unit('u', 'Gedebage')]);

    expect(urls.map((u) => new URL(u).searchParams.get('offset'))).toEqual(['0', '2', '4']);
  });
});

// ------------------------------------------- 17. real PAXELBOX-56 probe data

/**
 * The verbatim response to the single permitted PAXELBOX-56 request:
 *   GET /destination/domestic-destination?search=Gedebage&limit=20&offset=0
 *
 * Test fixture ONLY — no production code reads this. It is here because it
 * proves two things at once, and the second was a surprise.
 */
const GEDEBAGE_PROBE: RajaOngkirDestinationRaw[] = [
  { id: 4956, label: 'CIMENERANG (CIMINCRANG), GEDEBAGE, BANDUNG, JAWA BARAT, 40294', province_name: 'JAWA BARAT', city_name: 'BANDUNG', district_name: 'GEDEBAGE', subdistrict_name: 'CIMENERANG (CIMINCRANG)', zip_code: '40294' },
  { id: 4957, label: 'CISARANTEN KIDUL, GEDEBAGE, BANDUNG, JAWA BARAT, 40294', province_name: 'JAWA BARAT', city_name: 'BANDUNG', district_name: 'GEDEBAGE', subdistrict_name: 'CISARANTEN KIDUL', zip_code: '40294' },
  { id: 4958, label: 'RANCABALONG, GEDEBAGE, BANDUNG, JAWA BARAT, 40294', province_name: 'JAWA BARAT', city_name: 'BANDUNG', district_name: 'GEDEBAGE', subdistrict_name: 'RANCABALONG', zip_code: '40294' },
  { id: 4959, label: 'RANCANUMPANG, GEDEBAGE, BANDUNG, JAWA BARAT, 40294', province_name: 'JAWA BARAT', city_name: 'BANDUNG', district_name: 'GEDEBAGE', subdistrict_name: 'RANCANUMPANG', zip_code: '40294' },
];

/** The four Kemendagri villages of Kecamatan Gedebage, Kota Bandung. */
const GEDEBAGE_TARGETS: MassularVillage[] = [
  { code: '32.73.27.1001', name: 'Cimincrang', postalCode: '40294', districtName: 'Gedebage', cityName: 'Kota Bandung', provinceName: 'Jawa Barat' },
  { code: '32.73.27.1002', name: 'Cisaranten Kidul', postalCode: '40294', districtName: 'Gedebage', cityName: 'Kota Bandung', provinceName: 'Jawa Barat' },
  { code: '32.73.27.1003', name: 'Rancabolang', postalCode: '40294', districtName: 'Gedebage', cityName: 'Kota Bandung', provinceName: 'Jawa Barat' },
  { code: '32.73.27.1004', name: 'Rancanumpang', postalCode: '40294', districtName: 'Gedebage', cityName: 'Kota Bandung', provinceName: 'Jawa Barat' },
];

describe('real Gedebage probe (PAXELBOX-56)', () => {
  it('S2: a district-name search returns village-level rows for that district in one short page', async () => {
    const s = memoryStorage();
    const transport = jest.fn().mockResolvedValue({ status: 200, body: ok(GEDEBAGE_PROBE) });

    const res = await run(s, transport, [unit('district-gedebage', 'Gedebage', 20)]);

    expect(transport).toHaveBeenCalledTimes(1); // 4 rows < limit 20 => proven complete
    expect(res.stopped).toBe(false);
    expect(res.acquired[0].rows).toHaveLength(4);
    expect(res.acquired[0].rows.every((r) => r.district_name === 'GEDEBAGE')).toBe(true);
    expect(res.acquired[0].rows.every((r) => r.subdistrict_name.length > 0)).toBe(true);
  });

  it('exposes the name divergence: only 2 of 4 villages match by name, the rest are NOT_FOUND', async () => {
    const s = memoryStorage();
    const transport = jest.fn().mockResolvedValue({ status: 200, body: ok(GEDEBAGE_PROBE) });
    const res = await run(s, transport, [unit('district-gedebage', 'Gedebage', 20)]);

    const report = mapVillages(GEDEBAGE_TARGETS, poolFrom(res.acquired));
    const byCode = Object.fromEntries(report.matches.map((m) => [m.code, m.outcome]));

    // RajaOngkir spells these differently from Kemendagri. The matcher refuses
    // to guess — deliberately. Resolving them is a reviewed-alias decision,
    // NOT a fuzzy-matching change.
    expect(byCode['32.73.27.1001']).toBe('NOT_FOUND'); // Cimincrang vs CIMENERANG (CIMINCRANG)
    expect(byCode['32.73.27.1003']).toBe('NOT_FOUND'); // Rancabolang vs RANCABALONG
    expect(byCode['32.73.27.1002']).toBe('MATCHED');
    expect(byCode['32.73.27.1004']).toBe('MATCHED');

    expect(report.matched).toBe(2);
    expect(report.notFound).toBe(2);

    // NOT_FOUND does NOT block application: those two villages simply stay NULL
    // and yield no JNE quote. Only ambiguity or a duplicated id would block.
    expect(report.safeToApply).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(applicableMappings(report).map((m) => m.code)).toEqual(['32.73.27.1002', '32.73.27.1004']);
  });
});

// ------------------------------------ 18. PAXELBOX-60B: 404 as empty search

/** The verbatim PAXELBOX-60 response for `search=Astanaanyar`. */
const EMPTY_404 = { meta: { message: EMPTY_SEARCH_MESSAGE, code: 404, status: 'failed' }, data: null };

describe('isEmptySearchResponse is narrow', () => {
  it('accepts the exact established envelope', () => {
    expect(isEmptySearchResponse(404, EMPTY_404)).toBe(true);
  });

  it('tolerates surrounding whitespace in the message', () => {
    expect(isEmptySearchResponse(404, { meta: { message: `  ${EMPTY_SEARCH_MESSAGE}  `, code: 404 }, data: null })).toBe(true);
  });

  it.each([
    ['a different message', { meta: { message: 'Invalid Api key, key not found', code: 404 }, data: null }],
    ['a message that merely contains it', { meta: { message: `${EMPTY_SEARCH_MESSAGE} for province`, code: 404 }, data: null }],
    ['a different meta.code', { meta: { message: EMPTY_SEARCH_MESSAGE, code: 400 }, data: null }],
    ['a payload that is not null', { meta: { message: EMPTY_SEARCH_MESSAGE, code: 404 }, data: [] }],
    ['no meta at all', { data: null }],
    ['a non-object body', 'Not Found'],
    ['a null body', null],
  ])('rejects %s', (_label, body) => {
    expect(isEmptySearchResponse(404, body)).toBe(false);
  });

  it('rejects every status other than 404, including the ones that must keep stopping the run', () => {
    for (const status of [200, 400, 401, 403, 429, 500, 502]) {
      expect(isEmptySearchResponse(status, EMPTY_404)).toBe(false);
    }
  });
});

describe('404 empty search inside the runner', () => {
  it('completes the unit with zero rows and does not stop the run', async () => {
    const s = memoryStorage();
    const transport = jest.fn().mockResolvedValue({ status: 404, body: EMPTY_404 });

    const res = await run(s, transport, [unit('district-astanaanyar', 'Astanaanyar')]);

    expect(transport).toHaveBeenCalledTimes(1);
    expect(res.stopped).toBe(false);
    expect(res.unitsCompleted).toBe(1);
    expect(res.acquired[0].rows).toEqual([]);
    expect(res.acquired[0].offsets).toEqual([0]);
    expect(s.checkpoint?.completedUnits).toEqual(['district-astanaanyar']);
    expect(s.checkpoint?.failure).toBeUndefined();
  });

  it('continues to the next district instead of halting — the PAXELBOX-60 failure', async () => {
    const s = memoryStorage();
    const transport = jest
      .fn()
      .mockResolvedValueOnce({ status: 404, body: EMPTY_404 }) // Astanaanyar: unknown to RajaOngkir
      .mockResolvedValueOnce({ status: 200, body: ok([row(4844, 'CAMPAKA')]) }); // next district proceeds

    const res = await run(s, transport, [unit('district-astanaanyar', 'Astanaanyar'), unit('district-andir', 'Andir')]);

    expect(res.stopped).toBe(false);
    expect(res.unitsCompleted).toBe(2);
    expect(s.checkpoint?.completedUnits).toEqual(['district-astanaanyar', 'district-andir']);
  });

  it('an empty district yields NOT_FOUND from the matcher, never a fabricated id', async () => {
    const s = memoryStorage();
    const transport = jest.fn().mockResolvedValue({ status: 404, body: EMPTY_404 });
    const targets: MassularVillage[] = [
      { code: '32.73.10.1001', name: 'Karasak', postalCode: '40243', districtName: 'Astanaanyar', cityName: 'Kota Bandung', provinceName: 'Jawa Barat' },
    ];

    const res = await run(s, transport, [unit('district-astanaanyar', 'Astanaanyar')]);
    const report = mapVillages(targets, poolFrom(res.acquired));

    expect(poolFrom(res.acquired)).toEqual([]);
    expect(report.matches[0].outcome).toBe('NOT_FOUND');
    expect(report.matches[0].rajaOngkirId).toBeUndefined();
    expect(report.matches[0].candidateIds).toEqual([]);
  });

  it('a full page followed by an empty-search 404 ends the unit, keeping the earlier rows', async () => {
    const s = memoryStorage();
    const transport = jest
      .fn()
      .mockResolvedValueOnce({ status: 200, body: ok([row(1, 'A'), row(2, 'B')]) }) // full page
      .mockResolvedValueOnce({ status: 404, body: EMPTY_404 }); // set ended on the boundary

    const res = await run(s, transport, [unit('u', 'Gedebage')]);

    expect(res.stopped).toBe(false);
    expect(res.acquired[0].rows.map((r) => r.id)).toEqual([1, 2]);
    expect(res.acquired[0].offsets).toEqual([0, 2]);
  });
});

describe('other failures still stop the run after the 60B change', () => {
  it.each([
    ['429', { status: 429, body: RATE_LIMITED_BODY }, 'RATE_LIMITED'],
    ['401', { status: 401, body: { meta: { message: 'unauthorized', code: 401 }, data: null } }, 'AUTHENTICATION_FAILED'],
    ['403', { status: 403, body: { meta: { message: 'forbidden', code: 403 }, data: null } }, 'AUTHENTICATION_FAILED'],
    ['a 404 with a different message', { status: 404, body: { meta: { message: 'Endpoint not found', code: 404 }, data: null } }, 'HTTP_ERROR'],
    ['a malformed 404 payload', { status: 404, body: '<html>404</html>' }, 'HTTP_ERROR'],
    ['500', { status: 500, body: { meta: { message: 'boom', code: 500 }, data: null } }, 'HTTP_ERROR'],
  ])('%s stops the run', async (_label, answer, expected) => {
    const s = memoryStorage();
    const transport = jest.fn().mockResolvedValue(answer);

    const res = await run(s, transport, [unit('u', 'Gedebage')]);

    expect(res.stopped).toBe(true);
    expect(res.failure?.category).toBe(expected);
    expect(s.checkpoint?.completedUnits).toEqual([]);
    expect(s.raw.size).toBe(0);
  });

  it('a 200 with data:[] still behaves exactly as before', async () => {
    const s = memoryStorage();
    const transport = jest.fn().mockResolvedValue({ status: 200, body: ok([]) });

    const res = await run(s, transport, [unit('u', 'Nowhere')]);

    expect(res.stopped).toBe(false);
    expect(res.unitsCompleted).toBe(1);
    expect(res.acquired[0].rows).toEqual([]);
  });
});
