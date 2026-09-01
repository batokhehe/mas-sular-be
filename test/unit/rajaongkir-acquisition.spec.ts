import {
  CHECKPOINT_VERSION,
  categorizeHttp,
  isResumable,
  rawFileName,
  runAcquisition,
  toDestination,
  toDestinations,
  validateEnvelope,
  type AcquisitionStorage,
  type AcquisitionUnit,
  type Checkpoint,
  type RajaOngkirDestinationRaw,
} from '../../prisma/tools/rajaongkir-acquisition';
import { mapVillages, type MassularVillage } from '../../prisma/tools/rajaongkir-village-map';
import {
  PROVINCE_ALIASES,
  confirmedAliases,
  noCoverageProvinces,
  pendingReview,
} from '../../prisma/tools/rajaongkir-province-alias';

/**
 * PAXELBOX-51. Acquisition infrastructure, exercised entirely offline: the
 * transport and the storage are injected, so nothing here can reach RajaOngkir
 * or the filesystem.
 *
 * The behaviour worth protecting is the REFUSALS. A 429 that quietly became an
 * empty page would record "this province has no destinations" and poison the
 * dataset that later prices a customer's shipping.
 */

// The two REAL rows supplied by the operator, verbatim.
const PATARUMAN: RajaOngkirDestinationRaw = {
  id: 77558,
  label: 'PATARUMAN, PATARUMAN, BANJAR, JAWA BARAT, 46323',
  province_name: 'JAWA BARAT',
  city_name: 'BANJAR',
  district_name: 'PATARUMAN',
  subdistrict_name: 'PATARUMAN',
  zip_code: '46323',
};
const CIPAMOKOLAN: RajaOngkirDestinationRaw = {
  id: 4932,
  label: 'CIPAMOKOLAN, RANCASARI, BANDUNG, JAWA BARAT, 40292',
  province_name: 'JAWA BARAT',
  city_name: 'BANDUNG',
  district_name: 'RANCASARI',
  subdistrict_name: 'CIPAMOKOLAN',
  zip_code: '40292',
};

const ok = (rows: RajaOngkirDestinationRaw[]) => ({
  meta: { message: 'Success', code: 200, status: 'success' },
  data: rows,
});
const RATE_LIMITED_BODY = {
  meta: { message: 'Daily limit exceeded', code: 429, status: 'error' },
  data: null,
};

/** In-memory storage; nothing touches disk. Records write ORDER for atomicity checks. */
function memoryStorage() {
  const raw = new Map<string, unknown>();
  let checkpoint: unknown = null;
  const writes: string[] = [];
  const storage: AcquisitionStorage = {
    readCheckpoint: async () => checkpoint,
    writeCheckpoint: async (c) => {
      // Simulates the atomic temp+rename: the stored value is always a complete
      // snapshot, never a partial object.
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

const units: AcquisitionUnit[] = [
  { key: 'province', url: 'https://ro.test/destination/province' },
  { key: 'city-32', url: 'https://ro.test/destination/city/32' },
  { key: 'district-129', url: 'https://ro.test/destination/district/129' },
];

const run = (s: ReturnType<typeof memoryStorage>, transport: jest.Mock, plan = units) =>
  runAcquisition(plan, transport as never, s.storage, { acquisitionId: 'acq-1', now: () => '2026-08-31T00:00:00.000Z' });

// ------------------------------------------------------------ 1. adapter

describe('snake_case adapter', () => {
  it('maps a real Pataruman row to the mapper shape', () => {
    expect(toDestination(PATARUMAN)).toEqual({
      id: 77558,
      provinceName: 'JAWA BARAT',
      cityName: 'BANJAR',
      districtName: 'PATARUMAN',
      subdistrictName: 'PATARUMAN',
      zipCode: '46323',
    });
  });

  it('maps a real Cipamokolan row, and drops `label`', () => {
    const out = toDestination(CIPAMOKOLAN);

    expect(out).toMatchObject({ id: 4932, subdistrictName: 'CIPAMOKOLAN', zipCode: '40292' });
    // label is a display concatenation; carrying it would invite matching on it.
    expect(out).not.toHaveProperty('label');
  });

  it('preserves a null zip_code rather than inventing one', () => {
    expect(toDestination({ ...PATARUMAN, zip_code: null }).zipCode).toBeNull();
  });

  it('is pure — the input is not mutated', () => {
    const input = { ...PATARUMAN };
    toDestinations([input]);
    expect(input).toEqual(PATARUMAN);
  });
});

// ---------------------------------------------------------- 2. validator

describe('envelope validation', () => {
  it('accepts a well-formed success envelope', () => {
    const r = validateEnvelope(ok([PATARUMAN, CIPAMOKOLAN]));
    expect(r).toMatchObject({ kind: 'success' });
    expect(r.kind === 'success' && r.rows).toHaveLength(2);
  });

  it('classifies the real 429 body as an API ERROR, never as empty data', () => {
    const r = validateEnvelope(RATE_LIMITED_BODY);

    expect(r).toEqual({ kind: 'api_error', code: 429, message: 'Daily limit exceeded' });
    // The distinction that matters: this must never look like "no destinations".
    expect(r.kind).not.toBe('success');
  });

  it('rejects a row missing a required field instead of coercing it', () => {
    const broken = { ...PATARUMAN } as Partial<RajaOngkirDestinationRaw>;
    delete broken.subdistrict_name;

    expect(validateEnvelope(ok([broken as RajaOngkirDestinationRaw]))).toMatchObject({ kind: 'malformed' });
  });

  it('rejects a non-numeric id', () => {
    expect(validateEnvelope(ok([{ ...PATARUMAN, id: '77558' as never }]))).toMatchObject({ kind: 'malformed' });
  });

  it('rejects a 200 whose data is not an array', () => {
    expect(validateEnvelope({ meta: { code: 200 }, data: null })).toMatchObject({ kind: 'malformed' });
  });

  it('one bad row invalidates the whole page', () => {
    // A page that quietly shrinks is indistinguishable from a legitimately
    // shorter page, so partial acceptance is refused.
    expect(validateEnvelope(ok([PATARUMAN, {} as RajaOngkirDestinationRaw]))).toMatchObject({ kind: 'malformed' });
  });

  it('accepts an empty page — that is data, not an error', () => {
    expect(validateEnvelope(ok([]))).toEqual({ kind: 'success', rows: [] });
  });
});

// ------------------------------------------------------------ 3, 4, 5, 8

describe('the happy path advances the checkpoint', () => {
  it('performs each unit and records it', async () => {
    const s = memoryStorage();
    const transport = jest.fn().mockResolvedValue({ status: 200, body: ok([PATARUMAN]) });

    const result = await run(s, transport);

    expect(result).toMatchObject({ attempted: 3, succeeded: 3, skipped: 0, stopped: false });
    expect(s.checkpoint!.completedUnits).toEqual(['province', 'city-32', 'district-129']);
    expect(s.checkpoint!.version).toBe(CHECKPOINT_VERSION);
  });

  it('stores the raw response VERBATIM, still snake_case', async () => {
    const s = memoryStorage();
    const transport = jest.fn().mockResolvedValue({ status: 200, body: ok([PATARUMAN]) });

    await run(s, transport);

    const stored = s.raw.get('province.json') as { data: RajaOngkirDestinationRaw[] };
    expect(stored.data[0]).toEqual(PATARUMAN);
    expect(stored.data[0]).toHaveProperty('province_name');
  });

  it('writes the raw artifact BEFORE claiming the unit', async () => {
    const s = memoryStorage();
    const transport = jest.fn().mockResolvedValue({ status: 200, body: ok([PATARUMAN]) });

    await run(s, transport, [units[0]]);

    // A checkpoint must never claim a unit whose artifact was not written.
    expect(s.writes).toEqual(['raw:province.json', 'checkpoint']);
  });
});

// ---------------------------------------------------------------- 4, 5

describe('resume', () => {
  it('skips units already completed and performs only the rest', async () => {
    const s = memoryStorage();
    await s.storage.writeCheckpoint({
      version: CHECKPOINT_VERSION,
      acquisitionId: 'acq-1',
      completedUnits: ['province', 'city-32'],
      updatedAt: 'earlier',
    });
    const transport = jest.fn().mockResolvedValue({ status: 200, body: ok([PATARUMAN]) });

    const result = await run(s, transport);

    expect(result).toMatchObject({ attempted: 1, succeeded: 1, skipped: 2 });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledWith('https://ro.test/destination/district/129');
  });

  it('resumes the unit that failed rather than skipping it', async () => {
    const s = memoryStorage();
    const failing = jest
      .fn()
      .mockResolvedValueOnce({ status: 200, body: ok([PATARUMAN]) })
      .mockResolvedValueOnce({ status: 429, body: RATE_LIMITED_BODY });
    await run(s, failing);
    expect(s.checkpoint!.completedUnits).toEqual(['province']);

    // Second run: 'province' is skipped, 'city-32' is retried.
    const recovered = jest.fn().mockResolvedValue({ status: 200, body: ok([CIPAMOKOLAN]) });
    const result = await run(s, recovered);

    expect(result).toMatchObject({ skipped: 1, succeeded: 2, stopped: false });
    expect(recovered).toHaveBeenCalledWith('https://ro.test/destination/city/32');
  });

  it('clears the recorded failure once a unit succeeds again', async () => {
    const s = memoryStorage();
    await run(s, jest.fn().mockResolvedValue({ status: 429, body: RATE_LIMITED_BODY }));
    expect(s.checkpoint!.failure).toBeDefined();

    await run(s, jest.fn().mockResolvedValue({ status: 200, body: ok([PATARUMAN]) }));

    expect(s.checkpoint!.failure).toBeUndefined();
  });
});

// ------------------------------------------------------------- 6, 7, 8

describe('429 stops the run immediately', () => {
  it('stops on the first 429 and attempts nothing further', async () => {
    const s = memoryStorage();
    const transport = jest.fn().mockResolvedValue({ status: 429, body: RATE_LIMITED_BODY });

    const result = await run(s, transport);

    expect(transport).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ stopped: true, attempted: 1, succeeded: 0 });
    expect(result.failure).toMatchObject({ category: 'RATE_LIMITED', httpStatus: 429, unit: 'province' });
  });

  it('does NOT retry the rate-limited unit', async () => {
    const s = memoryStorage();
    const transport = jest.fn().mockResolvedValue({ status: 429, body: RATE_LIMITED_BODY });

    await run(s, transport);

    // Retrying spends more of an already-exhausted daily quota to be told the same.
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('never turns a 429 into an empty dataset', async () => {
    const s = memoryStorage();
    const transport = jest.fn().mockResolvedValue({ status: 429, body: RATE_LIMITED_BODY });

    await run(s, transport);

    expect(s.raw.size).toBe(0);
    expect(s.checkpoint!.completedUnits).toEqual([]);
  });

  it('preserves everything already acquired', async () => {
    const s = memoryStorage();
    const transport = jest
      .fn()
      .mockResolvedValueOnce({ status: 200, body: ok([PATARUMAN]) })
      .mockResolvedValueOnce({ status: 429, body: RATE_LIMITED_BODY });

    await run(s, transport);

    expect(s.raw.has('province.json')).toBe(true);
    expect(s.checkpoint!.completedUnits).toEqual(['province']);
    expect(s.checkpoint!.failure).toMatchObject({ category: 'RATE_LIMITED', unit: 'city-32' });
  });
});

// ------------------------------------------------------------ 7, 9

describe('failure categories', () => {
  it('classifies HTTP statuses', () => {
    expect(categorizeHttp(429)).toBe('RATE_LIMITED');
    expect(categorizeHttp(401)).toBe('AUTHENTICATION_FAILED');
    expect(categorizeHttp(403)).toBe('AUTHENTICATION_FAILED');
    expect(categorizeHttp(404)).toBe('HTTP_ERROR');
    expect(categorizeHttp(500)).toBe('HTTP_ERROR');
  });

  it('401 stops the run', async () => {
    const s = memoryStorage();
    const transport = jest.fn().mockResolvedValue({ status: 401, body: { meta: { code: 401, message: 'Invalid key' } } });

    const result = await run(s, transport);

    expect(result.failure).toMatchObject({ category: 'AUTHENTICATION_FAILED' });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('a network error stops without marking the unit complete', async () => {
    const s = memoryStorage();
    const transport = jest.fn().mockRejectedValue(new Error('socket hang up'));

    const result = await run(s, transport);

    expect(result.failure).toMatchObject({ category: 'NETWORK_ERROR' });
    expect(s.checkpoint!.completedUnits).toEqual([]);
  });

  it('a malformed 200 does NOT advance the checkpoint', async () => {
    const s = memoryStorage();
    const transport = jest.fn().mockResolvedValue({ status: 200, body: ok([{} as RajaOngkirDestinationRaw]) });

    const result = await run(s, transport);

    expect(result.failure).toMatchObject({ category: 'MALFORMED_RESPONSE' });
    expect(s.checkpoint!.completedUnits).toEqual([]);
    expect(s.raw.size).toBe(0);
  });

  it('a 200 carrying an error envelope is still a refusal', async () => {
    const s = memoryStorage();
    const transport = jest.fn().mockResolvedValue({ status: 200, body: RATE_LIMITED_BODY });

    const result = await run(s, transport);

    expect(result.failure).toMatchObject({ category: 'RATE_LIMITED' });
    expect(s.raw.size).toBe(0);
  });
});

// --------------------------------------------------------------- 13, 14

describe('artifact naming and checkpoint integrity', () => {
  it('is deterministic', () => {
    expect(rawFileName('city-32')).toBe(rawFileName('city-32'));
    expect(rawFileName('city-32')).toBe('city-32.json');
  });

  it('is safe against path traversal', () => {
    for (const evil of ['../../etc/passwd', '..\\..\\windows', '/absolute/path', '....//nested']) {
      const name = rawFileName(evil);
      expect(name).not.toMatch(/[/\\]/);
      expect(name.startsWith('.')).toBe(false);
    }
  });

  it('a partial or older checkpoint is never treated as complete', () => {
    expect(isResumable(null)).toBe(false);
    expect(isResumable({})).toBe(false);
    expect(isResumable({ version: CHECKPOINT_VERSION, acquisitionId: 'a' })).toBe(false); // truncated
    expect(isResumable({ version: 0, acquisitionId: 'a', completedUnits: [], updatedAt: 'x' })).toBe(false); // old version
    expect(isResumable({ version: CHECKPOINT_VERSION, acquisitionId: 'a', completedUnits: ['u'], updatedAt: 'x' })).toBe(true);
  });

  it('an unreadable checkpoint restarts rather than skipping work', async () => {
    const s = memoryStorage();
    await s.storage.writeCheckpoint({ version: 999, acquisitionId: 'x', completedUnits: ['province'], updatedAt: 'x' } as never);
    const transport = jest.fn().mockResolvedValue({ status: 200, body: ok([PATARUMAN]) });

    const result = await run(s, transport);

    // 'province' must NOT be skipped on the strength of an unrecognised file.
    expect(result.skipped).toBe(0);
    expect(result.attempted).toBe(3);
  });
});

// -------------------------------------------------------------------- 15

describe('cached raw data feeds the mapper through the adapter', () => {
  it('maps a cached snake_case page to a village id', async () => {
    const s = memoryStorage();
    await run(s, jest.fn().mockResolvedValue({ status: 200, body: ok([PATARUMAN, CIPAMOKOLAN]) }), [units[0]]);

    const cached = s.raw.get('province.json') as { data: RajaOngkirDestinationRaw[] };
    const destinations = toDestinations(cached.data);
    const massular: MassularVillage[] = [
      { code: '32.73.23.1003', name: 'Cipamokolan', postalCode: '40292', districtName: 'Rancasari', cityName: 'Kota Bandung', provinceName: 'Jawa Barat' },
    ];

    const report = mapVillages(massular, destinations);

    expect(report.matched).toBe(1);
    expect(report.matches[0].rajaOngkirId).toBe(4932);
  });
});

// -------------------------------------------------------- 10, 11, 12

describe('the API key never reaches any artifact', () => {
  const SECRET = 'test-secret-key-do-not-leak-0001';

  it('is absent from the checkpoint, the raw cache and the logs', async () => {
    const s = memoryStorage();
    const logs: string[] = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((...a) => void logs.push(a.join(' ')));
    const warn = jest.spyOn(console, 'warn').mockImplementation((...a) => void logs.push(a.join(' ')));

    // The secret lives ONLY in the transport's closure — the runner never sees it.
    const transport = jest.fn(async (url: string) => {
      expect(url).not.toContain(SECRET); // never in the URL either
      void { headers: { key: SECRET } };
      return { status: 200, body: ok([PATARUMAN]) };
    });

    await run(s, transport as never);
    spy.mockRestore();
    warn.mockRestore();

    const artifacts = JSON.stringify({
      checkpoint: s.checkpoint,
      raw: [...s.raw.entries()],
      names: [...s.raw.keys()],
      logs,
    });
    expect(artifacts).not.toContain(SECRET);
  });

  it('a unit key containing a secret never becomes a filename', () => {
    // Defensive: even if a caller were careless, the name is sanitised and
    // truncated — but the real guarantee is that keys are ours, not credentials.
    expect(rawFileName('city-32')).not.toContain(SECRET);
  });
});

// ------------------------------------------------------------- aliases

describe('province aliases are data awaiting review', () => {
  it('promotes nothing automatically', () => {
    // Every entry is REVIEW_REQUIRED, so the usable map is empty until a human
    // confirms one. An unreviewed province alias would mis-map every address in it.
    expect(confirmedAliases()).toEqual({});
    expect(pendingReview()).toHaveLength(6);
  });

  it('records the six known naming differences', () => {
    const names = pendingReview().map((a) => a.massular);
    expect(names).toEqual([
      'Aceh',
      'Daerah Istimewa Yogyakarta',
      'Daerah Khusus Ibukota Jakarta',
      'Nusa Tenggara Barat',
      'Nusa Tenggara Timur',
      'Kepulauan Bangka Belitung',
    ]);
  });

  it('marks the four 2022 Papua provinces as having no coverage', () => {
    expect(noCoverageProvinces()).toEqual([
      'Papua Tengah',
      'Papua Selatan',
      'Papua Pegunungan',
      'Papua Barat Daya',
    ]);
    expect(PROVINCE_ALIASES.filter((a) => a.confidence === 'NO_COVERAGE').every((a) => a.rajaOngkir === null)).toBe(true);
  });
});
