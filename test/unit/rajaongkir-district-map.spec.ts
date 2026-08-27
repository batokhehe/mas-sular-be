import {
  applicableMappings,
  formatSample,
  isAggregateRow,
  mapDistricts,
  normalizeName,
  type MassularDistrict,
  type RajaOngkirDistrict,
} from '../../prisma/tools/rajaongkir-district-map';

/**
 * PAXELBOX-41. RajaOngkir prices by its own numeric district id, so every
 * Massular district needs one before a JNE quote is possible.
 *
 * The dangerous version of this job is a name search at checkout time: it can
 * return several candidates, and a wrong pick silently misprices an order the
 * customer then pays. So identity is resolved offline, by EXACT hierarchy, and
 * anything the data cannot answer confidently is refused rather than guessed.
 *
 * These pin the refusals, because the refusals are the whole point.
 */

const massular = (over: Partial<MassularDistrict> = {}): MassularDistrict => ({
  code: '32.09.29',
  name: 'Kaliwedi',
  cityName: 'Kabupaten Cirebon',
  provinceName: 'Jawa Barat',
  ...over,
});

const ro = (over: Partial<RajaOngkirDistrict> = {}): RajaOngkirDistrict => ({
  id: 1361,
  name: 'KALIWEDI',
  cityName: 'KABUPATEN CIREBON',
  provinceName: 'JAWA BARAT',
  zipCode: '45165',
  ...over,
});

// ----------------------------------------------------------------- 2, 8

describe('an exact hierarchy match is the only thing that maps', () => {
  it('matches on province + city + district, case and spacing insensitive', () => {
    const report = mapDistricts([massular()], [ro()]);

    expect(report.matched).toBe(1);
    expect(report.matches[0]).toMatchObject({ outcome: 'MATCH', rajaOngkirId: 1361, code: '32.09.29' });
    expect(report.safeToApply).toBe(true);
  });

  it('keeps the Kemendagri code as the join key, untouched', () => {
    const report = mapDistricts([massular({ code: '36.73.06' })], [ro()]);

    // The code is carried through verbatim — the tool never rewrites identity.
    expect(applicableMappings(report)).toEqual([{ code: '36.73.06', rajaOngkirId: 1361 }]);
  });

  it('refuses a district-name match when the city differs', () => {
    // Indonesia has many repeated kecamatan names; the name alone means nothing.
    const report = mapDistricts([massular()], [ro({ cityName: 'KOTA BANDUNG' })]);

    expect(report.matches[0].outcome).toBe('NOT_FOUND');
    expect(report.matched).toBe(0);
  });

  it('refuses a match when only the province differs', () => {
    const report = mapDistricts([massular()], [ro({ provinceName: 'JAWA TENGAH' })]);

    expect(report.matches[0].outcome).toBe('NOT_FOUND');
  });

  it('never matches on postal code', () => {
    // Same zip, different hierarchy ⇒ still NOT_FOUND.
    const report = mapDistricts([massular()], [ro({ name: 'SOMEWHERE ELSE', zipCode: '45165' })]);

    expect(report.matches[0].outcome).toBe('NOT_FOUND');
  });
});

// -------------------------------------------------------------------- 3

describe('no candidate leaves the mapping null', () => {
  it('reports NOT_FOUND and emits nothing for that district', () => {
    const report = mapDistricts([massular()], []);

    expect(report).toMatchObject({ total: 1, matched: 0, notFound: 1, ambiguous: 0 });
    expect(applicableMappings(report)).toEqual([]);
    // Not a blocker: an unmapped district simply yields no JNE quote.
    expect(report.safeToApply).toBe(true);
  });

  it('still maps the districts it CAN identify', () => {
    const report = mapDistricts(
      [massular(), massular({ code: '32.09.30', name: 'Gebang' })],
      [ro()],
    );

    expect(report.matched).toBe(1);
    expect(report.notFound).toBe(1);
    expect(applicableMappings(report)).toEqual([{ code: '32.09.29', rajaOngkirId: 1361 }]);
  });
});

// -------------------------------------------------------------------- 4

describe('ambiguity is a failure, never a choice', () => {
  it('reports AMBIGUOUS when two RajaOngkir rows share one hierarchy', () => {
    const report = mapDistricts([massular()], [ro({ id: 1361 }), ro({ id: 9999 })]);

    expect(report.matches[0]).toMatchObject({ outcome: 'AMBIGUOUS', candidateIds: [1361, 9999] });
    expect(report.matches[0].rajaOngkirId).toBeUndefined();
  });

  it('does NOT take the first result', () => {
    const report = mapDistricts([massular()], [ro({ id: 1361 }), ro({ id: 9999 })]);

    expect(applicableMappings(report)).toEqual([]);
  });

  it('blocks the whole run rather than writing the unambiguous rows', () => {
    // One bad row poisons the batch on purpose: an ambiguous hierarchy means the
    // dataset is telling us something we do not understand yet.
    const report = mapDistricts(
      [massular(), massular({ code: '32.09.30', name: 'Gebang' })],
      [ro({ id: 1361 }), ro({ id: 9999 }), ro({ id: 7000, name: 'GEBANG' })],
    );

    expect(report.ambiguous).toBe(1);
    expect(report.safeToApply).toBe(false);
    expect(report.blockers[0]).toMatch(/matched more than one RajaOngkir id/);
    expect(applicableMappings(report)).toEqual([]);
  });
});

// -------------------------------------------------------------------- 5

describe('duplicate RajaOngkir ids are detected', () => {
  it('flags one id claimed by two districts', () => {
    const report = mapDistricts(
      [massular({ code: '32.09.29' }), massular({ code: '32.09.30', name: 'Gebang' })],
      [ro({ id: 1361 }), ro({ id: 1361, name: 'GEBANG' })],
    );

    expect(report.duplicateIds).toEqual([1361]);
    expect(report.safeToApply).toBe(false);
    expect(report.blockers.join(' ')).toMatch(/claimed by multiple districts/);
    expect(applicableMappings(report)).toEqual([]);
  });
});

// -------------------------------------------------------------------- 6

describe('non-kecamatan aggregate rows are excluded', () => {
  it('drops rows RajaOngkir marks with zip_code "0"', () => {
    // Observed verbatim in the API: "JAKARTA SELATAN" (a kota) is returned in the
    // district list beside real kecamatan, with zip_code "0".
    expect(isAggregateRow({ id: 1360, name: 'JAKARTA SELATAN', cityName: 'X', provinceName: 'Y', zipCode: '0' })).toBe(true);
    expect(isAggregateRow(ro())).toBe(false);
  });

  it('does not attach a city-level id to a kecamatan row', () => {
    const report = mapDistricts(
      [massular({ name: 'Jakarta Selatan', cityName: 'Kota Jakarta Selatan', provinceName: 'DKI Jakarta' })],
      [{ id: 1360, name: 'JAKARTA SELATAN', cityName: 'KOTA JAKARTA SELATAN', provinceName: 'DKI JAKARTA', zipCode: '0' }],
    );

    // Refused rather than mapped to an aggregate.
    expect(report.matches[0].outcome).toBe('NOT_FOUND');
    expect(report.matched).toBe(0);
  });
});

// -------------------------------------------------------------------- 7

describe('the mapping is deterministic', () => {
  it('produces identical output when run twice', () => {
    const m = [massular(), massular({ code: '32.09.30', name: 'Gebang' })];
    const r = [ro(), ro({ id: 7000, name: 'GEBANG' })];

    expect(JSON.stringify(mapDistricts(m, r))).toBe(JSON.stringify(mapDistricts(m, r)));
  });

  it('is independent of input ordering for the emitted rows', () => {
    const a = mapDistricts(
      [massular(), massular({ code: '32.09.30', name: 'Gebang' })],
      [ro(), ro({ id: 7000, name: 'GEBANG' })],
    );
    const b = mapDistricts(
      [massular({ code: '32.09.30', name: 'Gebang' }), massular()],
      [ro({ id: 7000, name: 'GEBANG' }), ro()],
    );

    expect(applicableMappings(a)).toEqual(applicableMappings(b));
  });
});

// --------------------------------------------------------- normalisation

describe('name normalisation stays conservative', () => {
  it('folds case, punctuation and repeated spaces', () => {
    expect(normalizeName('  Kab.  Cirebon ')).toBe('KAB CIREBON');
    expect(normalizeName("Ma'rang")).toBe('MA RANG');
  });

  it('does NOT strip administrative prefixes or guess abbreviations', () => {
    // "KAB CIREBON" and "KABUPATEN CIREBON" stay different on purpose — turning
    // one into the other is how a wrong district gets a confident-looking id.
    expect(normalizeName('Kab. Cirebon')).not.toBe(normalizeName('Kabupaten Cirebon'));
  });
});

// ------------------------------------------------------------- reporting

describe('the sample report is reviewable', () => {
  it('shows the hierarchy, the id and the outcome, and flags candidates', () => {
    const report = mapDistricts([massular()], [ro({ id: 1361 }), ro({ id: 9999 })]);

    const text = formatSample(report);
    expect(text).toContain('AMBIGUOUS');
    expect(text).toContain('1361, 9999');
    expect(text).toContain('safeToApply=false');
  });
});
