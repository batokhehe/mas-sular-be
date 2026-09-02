import {
  EXPECTED_SANDBOX_ROWS,
  JNE_CODE_PATTERN,
  JneMasterValidationError,
  SANDBOX_TEST_CODES,
  assertExpectedRowCount,
  computeImportDiff,
  isTestCode,
  normalizeJneName,
  parseJneName,
  toJneLocationSeeds,
  validateJneMasterPayload,
  type JneMasterRaw,
} from '../../prisma/tools/jne-master';
import { extractPayload, parseArgs, verifyRawNames, CONFIRM_FLAG } from '../../prisma/tools/import-jne-master';

/**
 * PAXELBOX-61E. The JNE master transformer, exercised entirely offline.
 *
 * The property that matters most is that `rawName` survives untouched. The real
 * sandbox dataset is messy in ways that are themselves evidence — 1,370 rows
 * with spacing around the comma, 566 with edge whitespace, one that splits into
 * three parts where two were meant. Normalising on write would erase exactly
 * what a reviewer needs to judge a mapping, so every test below that touches a
 * dirty name checks the raw value is still byte-identical afterwards.
 */

const FETCHED = '2026-09-02T02:40:46.000Z';
const opts = { sourceFetchedAt: FETCHED };

/** Rows copied verbatim from the PAXELBOX-61C capture, including the anomalies. */
const REAL_ROWS: JneMasterRaw[] = [
  { City_Name: 'CIBIRU,BANDUNG', City_Code: 'BDO10002' },
  { City_Name: 'UJUNGBERUNG, BANDUNG', City_Code: 'BDO10018' }, // space after comma
  { City_Name: 'BANDUNG', City_Code: 'BDO10000' }, // city tier, no parent
  { City_Name: 'COBLONG,BANDUG', City_Code: 'BDO10054' }, // JNE's own typo
  { City_Name: 'SOREANG,KAB.BANDUNG', City_Code: 'BDO10100' },
  { City_Name: 'LUBUKSIKAPING,KAB,PASAMAN', City_Code: 'PDG20300' }, // 3 parts
  { City_Name: 'ANGUILA, ALL CITY, CARIBBEAN', City_Code: 'AXA10000' },
  { City_Name: 'TEST', City_Code: 'TEST' },
  { City_Name: 'TEST DATA', City_Code: 'XXWWQEQ' },
];

// ------------------------------------------------------ 1. raw preservation

describe('rawName is preserved exactly', () => {
  it('carries every source name through byte-for-byte', () => {
    const seeds = toJneLocationSeeds(REAL_ROWS, opts);
    seeds.forEach((s, i) => expect(s.rawName).toBe(REAL_ROWS[i].City_Name));
  });

  it('does not trim, collapse or re-case a dirty name', () => {
    const [dirty] = toJneLocationSeeds([{ City_Name: '  UJUNGBERUNG,  BANDUNG  ', City_Code: 'BDO10018' }], opts);

    expect(dirty.rawName).toBe('  UJUNGBERUNG,  BANDUNG  ');
    // The derived field is cleaned; the raw one is not.
    expect(dirty.normalizedName).toBe('UJUNGBERUNG,BANDUNG');
    expect(dirty.rawName).not.toBe(dirty.normalizedName);
  });

  it('verifyRawNames reports zero mismatches for a faithful transform', () => {
    const seeds = toJneLocationSeeds(REAL_ROWS, opts);
    const v = verifyRawNames(seeds, REAL_ROWS);

    expect(v.checked).toBe(REAL_ROWS.length);
    expect(v.mismatches).toEqual([]);
  });

  it('verifyRawNames CATCHES a rewritten name — the guarantee is checked, not assumed', () => {
    const seeds = toJneLocationSeeds(REAL_ROWS, opts);
    seeds[1] = { ...seeds[1], rawName: 'UJUNGBERUNG,BANDUNG' }; // silently "cleaned"

    const v = verifyRawNames(seeds, REAL_ROWS);
    expect(v.mismatches).toHaveLength(1);
    expect(v.mismatches[0].code).toBe('BDO10018');
  });
});

// ---------------------------------------------------------- 2-4. derivation

describe('normalization', () => {
  it.each([
    ['UJUNGBERUNG, BANDUNG', 'UJUNGBERUNG,BANDUNG'],
    ['  cibiru , bandung  ', 'CIBIRU,BANDUNG'],
    ['ANGUILA, ALL CITY, CARIBBEAN', 'ANGUILA,ALL CITY,CARIBBEAN'],
    ['BANDUNG', 'BANDUNG'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeJneName(input)).toBe(expected);
  });

  it('does NOT expand abbreviations or fix spelling', () => {
    // The typo and the abbreviation must stay visible to a reviewer.
    expect(normalizeJneName('COBLONG,BANDUG')).toBe('COBLONG,BANDUG');
    expect(normalizeJneName('SOREANG,KAB.BANDUNG')).toBe('SOREANG,KAB.BANDUNG');
    expect(normalizeJneName('NGAMPRAH,KAB.BANDUNG BRT')).toBe('NGAMPRAH,KAB.BANDUNG BRT');
  });
});

describe('parsing', () => {
  it('splits a two-part district name into child and parent', () => {
    expect(parseJneName('CIBIRU,BANDUNG')).toEqual({ child: 'CIBIRU', parent: 'BANDUNG', partCount: 2 });
  });

  it('leaves the city tier with a null parent', () => {
    expect(parseJneName('BANDUNG')).toEqual({ child: 'BANDUNG', parent: null, partCount: 1 });
  });

  it('takes the LAST part as parent for a three-part name', () => {
    // "LUBUKSIKAPING,KAB,PASAMAN" is Lubuksikaping in Kab. Pasaman - the second
    // part is a stray "KAB", so the parent must be the last part, not the second.
    expect(parseJneName('LUBUKSIKAPING,KAB,PASAMAN')).toEqual({
      child: 'LUBUKSIKAPING',
      parent: 'PASAMAN',
      partCount: 3,
    });
  });
});

describe('partCount', () => {
  it('records 1, 2 and 3 for the three observed shapes', () => {
    const seeds = toJneLocationSeeds(REAL_ROWS, opts);
    const byCode = Object.fromEntries(seeds.map((s) => [s.code, s]));

    expect(byCode.BDO10000.partCount).toBe(1); // city tier
    expect(byCode.BDO10002.partCount).toBe(2); // district tier
    expect(byCode.PDG20300.partCount).toBe(3);
    expect(byCode.AXA10000.partCount).toBe(3); // international
  });
});

// --------------------------------------------------------- 5-6. provenance

describe('provenance', () => {
  it('defaults to source SANDBOX and kind DESTINATION', () => {
    for (const s of toJneLocationSeeds(REAL_ROWS, opts)) {
      expect(s.source).toBe('SANDBOX');
      expect(s.kind).toBe('DESTINATION');
      expect(s.sourceFetchedAt).toBe(FETCHED);
    }
  });

  it('can be told the row came from PRODUCTION or is an ORIGIN', () => {
    const [s] = toJneLocationSeeds([REAL_ROWS[0]], { ...opts, source: 'PRODUCTION', kind: 'ORIGIN' });
    expect(s.source).toBe('PRODUCTION');
    expect(s.kind).toBe('ORIGIN');
  });
});

// ------------------------------------------------------- 7-8. test rows

describe('sandbox test rows are retained but inactive', () => {
  it('marks TEST and XXWWQEQ inactive', () => {
    const seeds = toJneLocationSeeds(REAL_ROWS, opts);
    const byCode = Object.fromEntries(seeds.map((s) => [s.code, s]));

    expect(byCode.TEST.isActive).toBe(false);
    expect(byCode.XXWWQEQ.isActive).toBe(false);
  });

  it('keeps them in the snapshot rather than dropping them', () => {
    const seeds = toJneLocationSeeds(REAL_ROWS, opts);
    // Dropping would make the import unreproducible and hide a sandbox/production
    // difference; they are imported and deactivated instead.
    expect(seeds).toHaveLength(REAL_ROWS.length);
    expect(seeds.map((s) => s.code)).toEqual(expect.arrayContaining(['TEST', 'XXWWQEQ']));
    expect(byRaw(seeds, 'TEST')).toBe('TEST');
  });

  it('every real code stays active', () => {
    const seeds = toJneLocationSeeds(REAL_ROWS, opts);
    for (const s of seeds.filter((x) => !['TEST', 'XXWWQEQ'].includes(x.code))) {
      expect(s.isActive).toBe(true);
      expect(JNE_CODE_PATTERN.test(s.code)).toBe(true);
    }
  });

  it('isTestCode and the constant agree', () => {
    expect(SANDBOX_TEST_CODES).toEqual(['TEST', 'XXWWQEQ']);
    expect(isTestCode('test')).toBe(true);
    expect(isTestCode('BDO10002')).toBe(false);
  });
});

function byRaw(seeds: ReturnType<typeof toJneLocationSeeds>, code: string): string {
  return seeds.find((s) => s.code === code)!.rawName;
}

// ------------------------------------------------- 9. fail-closed validation

describe('validation fails closed', () => {
  const ok = (rows: unknown) => ({ detail: rows });

  it('detects a duplicate City_Code', () => {
    expect(() =>
      validateJneMasterPayload(ok([
        { City_Name: 'A,B', City_Code: 'BDO10002' },
        { City_Name: 'C,D', City_Code: 'BDO10002' },
      ])),
    ).toThrow(/duplicate City_Code "BDO10002"/);
  });

  it.each([
    ['a non-object payload', 'nope'],
    ['a missing detail', {}],
    ['a non-array detail', { detail: 'x' }],
    ['an empty detail', { detail: [] }],
    ['a non-object row', ok(['x'])],
    ['a missing City_Name', ok([{ City_Code: 'BDO10002' }])],
    ['a missing City_Code', ok([{ City_Name: 'A,B' }])],
    ['a blank City_Name', ok([{ City_Name: '   ', City_Code: 'BDO10002' }])],
    ['a blank City_Code', ok([{ City_Name: 'A,B', City_Code: '  ' }])],
  ])('rejects %s', (_label, payload) => {
    expect(() => validateJneMasterPayload(payload)).toThrow(JneMasterValidationError);
  });

  it('accepts the real shape unchanged', () => {
    const rows = validateJneMasterPayload(ok(REAL_ROWS));
    expect(rows).toEqual(REAL_ROWS);
  });

  it('refuses an unexpected row count unless overridden', () => {
    expect(() => assertExpectedRowCount(8000)).toThrow(/8000 rows but 8322 were expected/);
    expect(() => assertExpectedRowCount(8000, undefined, true)).not.toThrow();
    expect(() => assertExpectedRowCount(EXPECTED_SANDBOX_ROWS)).not.toThrow();
  });
});

// ------------------------------------------------------------ import diff

describe('import diff', () => {
  it('reports every row as new against an empty table', () => {
    const seeds = toJneLocationSeeds(REAL_ROWS, opts);
    const d = computeImportDiff(seeds, []);

    expect(d.sourceRows).toBe(REAL_ROWS.length);
    expect(d.uniqueCodes).toBe(REAL_ROWS.length);
    expect(d.newCodes).toHaveLength(REAL_ROWS.length);
    expect(d.existingCodes).toEqual([]);
    expect(d.invalidOrTestCodes.sort()).toEqual(['TEST', 'XXWWQEQ']);
  });

  it('reports a changed rawName rather than overwriting silently', () => {
    const seeds = toJneLocationSeeds(REAL_ROWS, opts);
    const d = computeImportDiff(seeds, [{ code: 'BDO10002', rawName: 'CIBIRU,BANDUNG LAMA' }]);

    expect(d.changedRawName).toEqual([{ code: 'BDO10002', from: 'CIBIRU,BANDUNG LAMA', to: 'CIBIRU,BANDUNG' }]);
  });

  it('deactivates rather than deletes a code absent from the new snapshot', () => {
    const seeds = toJneLocationSeeds([REAL_ROWS[0]], opts);
    const d = computeImportDiff(seeds, [
      { code: 'BDO10002', rawName: 'CIBIRU,BANDUNG' },
      { code: 'BDO99999', rawName: 'GONE,BANDUNG' },
    ]);

    expect(d.deactivatedCodes).toEqual(['BDO99999']);
  });
});

// ------------------------------------------------------- CLI + no mappings

describe('the import CLI', () => {
  it('requires an explicit confirm flag to attempt any write', () => {
    expect(parseArgs(['--snapshot', 's.json']).confirmed).toBe(false);
    expect(parseArgs(['--snapshot', 's.json', CONFIRM_FLAG]).confirmed).toBe(true);
  });

  it('rejects an unknown kind or source', () => {
    expect(() => parseArgs(['--kind', 'VILLAGE'])).toThrow(/--kind must be/);
    expect(() => parseArgs(['--source', 'STAGING'])).toThrow(/--source must be/);
  });

  it('unwraps a 61C capture and reads its fetch date', () => {
    const capture = JSON.stringify({
      status: 200,
      headers: [['date', 'Tue, 02 Sep 2026 02:40:46 GMT']],
      text: JSON.stringify({ detail: REAL_ROWS }),
    });
    const { payload, fetchedAt } = extractPayload(capture);

    expect(validateJneMasterPayload(payload)).toHaveLength(REAL_ROWS.length);
    expect(fetchedAt).toBe('Tue, 02 Sep 2026 02:40:46 GMT');
  });

  it('refuses a capture that recorded a non-200 response', () => {
    expect(() => extractPayload(JSON.stringify({ status: 500, text: '{"detail":[]}' }))).toThrow(/HTTP 500/);
  });

  it('accepts a bare payload with no capture envelope', () => {
    const { payload, fetchedAt } = extractPayload(JSON.stringify({ detail: REAL_ROWS }));
    expect(validateJneMasterPayload(payload)).toHaveLength(REAL_ROWS.length);
    expect(fetchedAt).toBeNull();
  });
});

// ------------------------------------------------- 10-11. zero mappings

describe('this phase creates no mappings', () => {
  it('the transformer emits only JneLocation seeds — it has no mapping concept', () => {
    const seeds = toJneLocationSeeds(REAL_ROWS, opts);
    for (const s of seeds) {
      expect(Object.keys(s).sort()).toEqual(
        ['code', 'isActive', 'kind', 'normalizedName', 'parsedChild', 'parsedParent', 'partCount', 'rawName', 'source', 'sourceFetchedAt'].sort(),
      );
      expect(s).not.toHaveProperty('districtId');
      expect(s).not.toHaveProperty('status');
    }
  });

  it('nothing auto-maps a Kota Bandung district, including the four known aliases', () => {
    // CICADAS/MARGACINTA are the historic names of Antapani/Buahbatu. The module
    // must not know that - promoting them is a reviewed decision in a later phase.
    const rows: JneMasterRaw[] = [
      { City_Name: 'CICADAS,BANDUNG', City_Code: 'BDO10038' },
      { City_Name: 'MARGACINTA,BANDUNG', City_Code: 'BDO10056' },
      { City_Name: 'SUMURBANDUNG,BANDUNG', City_Code: 'BDO10060' },
      { City_Name: 'BABAKANCIPARAY,BANDUNG', City_Code: 'BDO10044' },
    ];
    const seeds = toJneLocationSeeds(rows, opts);

    const dumped = JSON.stringify(seeds);
    for (const internal of ['Antapani', 'Buahbatu', 'Sumur Bandung', 'Babakan Ciparay']) {
      expect(dumped).not.toContain(internal);
    }
    // Only what JNE said, carried verbatim.
    expect(seeds.map((s) => s.parsedChild)).toEqual(['CICADAS', 'MARGACINTA', 'SUMURBANDUNG', 'BABAKANCIPARAY']);
  });
});

// ------------------------------- 12. write-path regression (PAXELBOX-61F)

/**
 * PAXELBOX-61E.1 verified the upsert/deactivate path once, end to end against a
 * real container. That is strong evidence but not a guard: nothing would catch a
 * later regression. These tests exercise the ACTUAL diff logic the CLI drives
 * its writes from, so the decisions - insert, update, deactivate, never delete -
 * are pinned.
 */
describe('write-path decisions are driven by the real diff logic', () => {
  const snapshot = (rows: JneMasterRaw[]) => toJneLocationSeeds(rows, opts);

  it('a code absent from the DB is an INSERT', () => {
    const d = computeImportDiff(snapshot([{ City_Name: 'NEW,BANDUNG', City_Code: 'BDO19999' }]), []);
    expect(d.newCodes).toEqual(['BDO19999']);
    expect(d.existingCodes).toEqual([]);
  });

  it('a code already present with a different rawName is an UPDATE, and is reported', () => {
    const d = computeImportDiff(snapshot([{ City_Name: 'CIBIRU,BANDUNG', City_Code: 'BDO10002' }]), [
      { code: 'BDO10002', rawName: 'CIBIRU,BANDUNG OLD' },
    ]);

    expect(d.newCodes).toEqual([]);
    expect(d.existingCodes).toEqual(['BDO10002']);
    expect(d.changedRawName).toEqual([
      { code: 'BDO10002', from: 'CIBIRU,BANDUNG OLD', to: 'CIBIRU,BANDUNG' },
    ]);
  });

  it('an unchanged code is neither new nor reported as changed', () => {
    const d = computeImportDiff(snapshot([{ City_Name: 'CIBIRU,BANDUNG', City_Code: 'BDO10002' }]), [
      { code: 'BDO10002', rawName: 'CIBIRU,BANDUNG' },
    ]);
    expect(d.newCodes).toEqual([]);
    expect(d.changedRawName).toEqual([]);
  });

  it('a code missing from the new snapshot is DEACTIVATED, never deleted', () => {
    const d = computeImportDiff(snapshot([{ City_Name: 'KEPT,BANDUNG', City_Code: 'BDO10002' }]), [
      { code: 'BDO10002', rawName: 'KEPT,BANDUNG' },
      { code: 'BDO10018', rawName: 'GONE,BANDUNG' },
    ]);

    expect(d.deactivatedCodes).toEqual(['BDO10018']);
    // Nothing in the diff can express a delete - that is the point.
    expect(Object.keys(d)).not.toContain('deletedCodes');
  });

  it('historical rows survive a much smaller refresh', () => {
    const existing = Array.from({ length: 100 }, (_, i) => ({ code: `BDO2${String(i).padStart(4, '0')}`, rawName: `R${i}` }));
    const d = computeImportDiff(snapshot([{ City_Name: 'ONE,BANDUNG', City_Code: 'BDO10002' }]), existing);

    expect(d.deactivatedCodes).toHaveLength(100);
    expect(d.newCodes).toEqual(['BDO10002']);
  });

  it('a refresh preserves source and kind on every seed', () => {
    for (const s of snapshot(REAL_ROWS)) {
      expect(s.source).toBe('SANDBOX');
      expect(s.kind).toBe('DESTINATION');
    }
  });

  it('a refresh keeps TEST and XXWWQEQ inactive', () => {
    const seeds = snapshot(REAL_ROWS);
    expect(seeds.find((s) => s.code === 'TEST')!.isActive).toBe(false);
    expect(seeds.find((s) => s.code === 'XXWWQEQ')!.isActive).toBe(false);
  });

  it('duplicate-code protection fires before any write decision is computed', () => {
    // The CLI validates before diffing, so a duplicated source can never reach
    // the upsert loop and silently overwrite one row with another.
    expect(() =>
      validateJneMasterPayload({
        detail: [
          { City_Name: 'A,B', City_Code: 'BDO10002' },
          { City_Name: 'C,D', City_Code: 'BDO10002' },
        ],
      }),
    ).toThrow(/duplicate City_Code/);
  });
});
