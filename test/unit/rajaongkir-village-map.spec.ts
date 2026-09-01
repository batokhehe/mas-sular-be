import {
  applicableMappings,
  formatSample,
  mapVillages,
  normalizeName,
  type MassularVillage,
  type RajaOngkirDestination,
} from '../../prisma/tools/rajaongkir-village-map';

/**
 * PAXELBOX-49B. RajaOngkir prices by its own SUBDISTRICT id, so every Massular
 * village needs one before a JNE quote is possible.
 *
 * The dangerous version of this job is a name search at checkout: it can return
 * several candidates, and a wrong pick silently misprices an order the customer
 * then pays. So identity is resolved offline, by exact hierarchy, and anything
 * the data cannot answer confidently is refused rather than guessed.
 *
 * The key deliberately omits CITY: RajaOngkir's city merges Kota and Kabupaten
 * (its "CIREBON" spans both; its "BANDUNG" spans ten Kemendagri cities), so
 * comparing it would fail for every merged city.
 *
 * These pin the refusals, because the refusals are the whole point.
 */

const village = (over: Partial<MassularVillage> = {}): MassularVillage => ({
  code: '32.73.23.1003',
  name: 'Cipamokolan',
  postalCode: '40292',
  districtName: 'Rancasari',
  cityName: 'Kota Bandung',
  provinceName: 'Jawa Barat',
  ...over,
});

const dest = (over: Partial<RajaOngkirDestination> = {}): RajaOngkirDestination => ({
  id: 4932,
  provinceName: 'JAWA BARAT',
  cityName: 'BANDUNG',
  districtName: 'RANCASARI',
  subdistrictName: 'CIPAMOKOLAN',
  zipCode: '40292',
  ...over,
});

// ------------------------------------------------------------------- 1, 15

describe('exact village match', () => {
  it('matches province + district + subdistrict, case and spacing insensitive', () => {
    const report = mapVillages([village()], [dest()]);

    expect(report.matches[0]).toMatchObject({ outcome: 'MATCHED', rajaOngkirId: 4932 });
    expect(report.safeToApply).toBe(true);
    expect(applicableMappings(report)).toEqual([{ code: '32.73.23.1003', rajaOngkirId: 4932 }]);
  });

  it('the Pataruman case: district and subdistrict share a name', () => {
    // Verbatim from a real RajaOngkir response (PAXELBOX-50):
    //   { id: 77558, label: "PATARUMAN, PATARUMAN, BANJAR, JAWA BARAT, 46323",
    //     district_name: "PATARUMAN", subdistrict_name: "PATARUMAN" }
    // The key joins both levels, so a repeated name is not a collision — and
    // RajaOngkir's city "BANJAR" differing from our "Kota Banjar" is irrelevant
    // because city is never compared.
    const report = mapVillages(
      [village({ code: '32.79.02.1002', name: 'Pataruman', postalCode: '46323', districtName: 'Pataruman', cityName: 'Kota Banjar' })],
      [dest({ id: 77558, cityName: 'BANJAR', districtName: 'PATARUMAN', subdistrictName: 'PATARUMAN', zipCode: '46323' })],
    );

    expect(report.matches[0]).toMatchObject({ outcome: 'MATCHED', rajaOngkirId: 77558 });
  });

  it('the Rancasari case: three villages share 40292 and stay distinct', () => {
    // Verified against our own master — Rancasari holds Mekar Jaya (40292),
    // Manjahlega (40295), Derwati (40292) and Cipamokolan (40292). Postal code
    // alone could never separate them.
    const massular = [
      village({ code: '32.73.23.1001', name: 'Mekar Jaya', postalCode: '40292' }),
      village({ code: '32.73.23.1002', name: 'Manjahlega', postalCode: '40295' }),
      village({ code: '32.73.23.1003', name: 'Cipamokolan', postalCode: '40292' }),
    ];
    const ro = [
      dest({ id: 4930, subdistrictName: 'MEKAR JAYA', zipCode: '40292' }),
      dest({ id: 4931, subdistrictName: 'MANJAHLEGA', zipCode: '40295' }),
      dest({ id: 4932, subdistrictName: 'CIPAMOKOLAN', zipCode: '40292' }),
    ];

    const report = mapVillages(massular, ro);

    expect(report.matched).toBe(3);
    expect(applicableMappings(report)).toEqual([
      { code: '32.73.23.1001', rajaOngkirId: 4930 },
      { code: '32.73.23.1002', rajaOngkirId: 4931 },
      { code: '32.73.23.1003', rajaOngkirId: 4932 },
    ]);
  });
});

// ------------------------------------------------------------ 2, 3, 4, 17

describe('hierarchy mismatches refuse to match', () => {
  it('province mismatch => NOT_FOUND', () => {
    const report = mapVillages([village()], [dest({ provinceName: 'JAWA TENGAH' })]);
    expect(report.matches[0].outcome).toBe('NOT_FOUND');
  });

  it('district mismatch => NOT_FOUND', () => {
    const report = mapVillages([village()], [dest({ districtName: 'BUAHBATU' })]);
    expect(report.matches[0].outcome).toBe('NOT_FOUND');
  });

  it('subdistrict mismatch => NOT_FOUND', () => {
    const report = mapVillages([village()], [dest({ subdistrictName: 'DERWATI' })]);
    expect(report.matches[0].outcome).toBe('NOT_FOUND');
  });

  it('CITY mismatch does NOT break a valid mapping', () => {
    // RajaOngkir says "BANDUNG"; we say "Kota Bandung" — and its city can span
    // several of ours. City is never compared, so the match still succeeds.
    const report = mapVillages(
      [village({ cityName: 'Kabupaten Bandung' })],
      [dest({ cityName: 'BANDUNG' })],
    );

    expect(report.matches[0]).toMatchObject({ outcome: 'MATCHED', rajaOngkirId: 4932 });
  });
});

// ----------------------------------------------------------------------- 5

describe('postal code verifies, never selects', () => {
  it('a postal mismatch on an otherwise-exact match => REVIEW_REQUIRED', () => {
    const report = mapVillages([village({ postalCode: '40293' })], [dest({ zipCode: '40292' })]);

    expect(report.matches[0]).toMatchObject({ outcome: 'REVIEW_REQUIRED' });
    expect(report.matches[0].reason).toMatch(/postal code differs/);
    expect(report.matches[0].rajaOngkirId).toBeUndefined();
  });

  it('refuses to complete identity when either side has no postal code', () => {
    // PAXELBOX-52C: postal code is part of IDENTITY now, not just verification.
    // An absent one leaves identity incomplete, so even a lone name candidate is
    // sent for review rather than taken on names alone.
    const ours = mapVillages([village({ postalCode: null })], [dest()]);
    expect(ours.matches[0]).toMatchObject({ outcome: 'REVIEW_REQUIRED' });
    expect(ours.matches[0].reason).toMatch(/massular postal code is missing/);

    const theirs = mapVillages([village()], [dest({ zipCode: null })]);
    expect(theirs.matches[0]).toMatchObject({ outcome: 'REVIEW_REQUIRED' });
    expect(theirs.matches[0].reason).toMatch(/rajaongkir postal code is missing/);

    // Neither is emitted, but neither blocks the batch either.
    expect(applicableMappings(ours)).toEqual([]);
    expect(ours.safeToApply).toBe(true);
  });

  it('never matches on postal code alone', () => {
    // Same zip, different subdistrict ⇒ still nothing.
    const report = mapVillages([village()], [dest({ subdistrictName: 'SOMEWHERE ELSE', zipCode: '40292' })]);
    expect(report.matches[0].outcome).toBe('NOT_FOUND');
  });

  it('a REVIEW_REQUIRED row does not block the batch', () => {
    const report = mapVillages(
      [village({ postalCode: '40293' }), village({ code: '32.73.23.1004', name: 'Derwati', postalCode: '40292' })],
      [dest(), dest({ id: 4933, subdistrictName: 'DERWATI', zipCode: '40292' })],
    );

    expect(report.reviewRequired).toBe(1);
    expect(report.safeToApply).toBe(true);
    expect(applicableMappings(report)).toEqual([{ code: '32.73.23.1004', rajaOngkirId: 4933 }]);
  });
});

// ------------------------------- PAXELBOX-52C: postal code as identity

describe('postal code disambiguates the 52B collision', () => {
  /**
   * Observed live in PAXELBOX-52B — one name triple, two real places:
   *   JAWA TENGAH | KARANGANYAR | KARANGANYAR -> city KARANGANYAR, zip 57711
   *   JAWA TENGAH | KARANGANYAR | KARANGANYAR -> city KEBUMEN,     zip 54364
   * Before 52C the matcher saw two candidates and refused both. Postal code
   * separates them without ever consulting city.
   */
  const KARANGANYAR: RajaOngkirDestination[] = [
    { id: 61948, provinceName: 'JAWA TENGAH', cityName: 'KARANGANYAR', districtName: 'KARANGANYAR', subdistrictName: 'KARANGANYAR', zipCode: '57711' },
    { id: 44051, provinceName: 'JAWA TENGAH', cityName: 'KEBUMEN', districtName: 'KARANGANYAR', subdistrictName: 'KARANGANYAR', zipCode: '54364' },
  ];
  const inKaranganyar = village({ code: '33.13.09.1001', name: 'Karanganyar', districtName: 'Karanganyar', cityName: 'Kabupaten Karanganyar', provinceName: 'Jawa Tengah', postalCode: '57711' });
  const inKebumen = village({ code: '33.05.20.2001', name: 'Karanganyar', districtName: 'Karanganyar', cityName: 'Kabupaten Kebumen', provinceName: 'Jawa Tengah', postalCode: '54364' });

  it('selects the candidate whose postal code agrees', () => {
    const report = mapVillages([inKaranganyar], KARANGANYAR);

    expect(report.matches[0]).toMatchObject({ outcome: 'MATCHED', rajaOngkirId: 61948 });
    // Both were considered; only one survived.
    expect(report.matches[0].candidateIds).toEqual([61948, 44051]);
  });

  it('resolves BOTH villages to different ids in one run', () => {
    const report = mapVillages([inKaranganyar, inKebumen], KARANGANYAR);

    expect(report.matched).toBe(2);
    expect(applicableMappings(report)).toEqual([
      { code: '33.05.20.2001', rajaOngkirId: 44051 },
      { code: '33.13.09.1001', rajaOngkirId: 61948 },
    ]);
  });

  it('does so WITHOUT consulting city — our "Kabupaten Karanganyar" vs their "KARANGANYAR"', () => {
    // Same village, city renamed to something that matches neither candidate.
    const report = mapVillages([{ ...inKaranganyar, cityName: 'Somewhere Entirely Else' }], KARANGANYAR);

    expect(report.matches[0]).toMatchObject({ outcome: 'MATCHED', rajaOngkirId: 61948 });
  });

  it('a postal code matching NEITHER candidate is refused, not guessed', () => {
    const report = mapVillages([{ ...inKaranganyar, postalCode: '99999' }], KARANGANYAR);

    expect(report.matches[0]).toMatchObject({ outcome: 'REVIEW_REQUIRED' });
    expect(report.matches[0].reason).toMatch(/postal code differs \(massular 99999 vs rajaongkir 57711, 54364\)/);
    expect(applicableMappings(report)).toEqual([]);
  });

  it('candidate ORDER cannot change the result', () => {
    const forward = mapVillages([inKaranganyar, inKebumen], KARANGANYAR);
    const reversed = mapVillages([inKebumen, inKaranganyar], [...KARANGANYAR].reverse());

    expect(applicableMappings(forward)).toEqual(applicableMappings(reversed));
  });

  it('same names AND same postal code on several ids stays AMBIGUOUS', () => {
    // Postal code has nothing left to add, so the tie is never broken.
    const tied = KARANGANYAR.map((d) => ({ ...d, zipCode: '57711' }));
    const report = mapVillages([inKaranganyar], tied);

    expect(report.matches[0]).toMatchObject({ outcome: 'AMBIGUOUS' });
    expect(report.matches[0].reason).toMatch(/share this hierarchy and postal code/);
    expect(report.safeToApply).toBe(false);
    expect(applicableMappings(report)).toEqual([]);
  });
});

describe('postal codes are compared as strings', () => {
  it('preserves a leading zero', () => {
    const report = mapVillages(
      [village({ postalCode: '01234' })],
      [dest({ zipCode: '01234' })],
    );

    // "01234" must not become 1234 — a numeric compare would match the wrong place.
    expect(report.matches[0]).toMatchObject({ outcome: 'MATCHED' });
    expect(mapVillages([village({ postalCode: '01234' })], [dest({ zipCode: '1234' })]).matches[0].outcome).toBe('REVIEW_REQUIRED');
  });

  it('tolerates surrounding whitespace on either side', () => {
    expect(mapVillages([village({ postalCode: ' 40292 ' })], [dest()]).matches[0]).toMatchObject({ outcome: 'MATCHED' });
    expect(mapVillages([village()], [dest({ zipCode: ' 40292 ' })]).matches[0]).toMatchObject({ outcome: 'MATCHED' });
  });

  it('treats an empty or whitespace-only postal code as missing, not as a value', () => {
    const report = mapVillages([village({ postalCode: '   ' })], [dest()]);

    expect(report.matches[0]).toMatchObject({ outcome: 'REVIEW_REQUIRED' });
    expect(report.matches[0].reason).toMatch(/massular postal code is missing/);
  });
});

// -------------------------------------------------------------- 6, 7, 11, 16

describe('ambiguity is a failure, never a choice', () => {
  it('two RajaOngkir rows under one hierarchy => AMBIGUOUS', () => {
    const report = mapVillages([village()], [dest({ id: 4932 }), dest({ id: 9999 })]);

    expect(report.matches[0]).toMatchObject({ outcome: 'AMBIGUOUS', candidateIds: [4932, 9999] });
    expect(report.matches[0].rajaOngkirId).toBeUndefined();
  });

  it('does NOT take the first result', () => {
    const report = mapVillages([village()], [dest({ id: 4932 }), dest({ id: 9999 })]);
    expect(applicableMappings(report)).toEqual([]);
  });

  it('blocks the whole run rather than writing the unambiguous rows', () => {
    const report = mapVillages(
      [village(), village({ code: '32.73.23.1004', name: 'Derwati' })],
      [dest({ id: 4932 }), dest({ id: 9999 }), dest({ id: 4933, subdistrictName: 'DERWATI' })],
    );

    expect(report.ambiguous).toBe(1);
    expect(report.safeToApply).toBe(false);
    expect(report.blockers[0]).toMatch(/more than one RajaOngkir destination/);
    expect(applicableMappings(report)).toEqual([]);
  });

  it('same-name villages inside one district are refused', () => {
    // 16 such keys (32 rows) exist nationally, e.g. two "Anjareuw" in Samofa.
    const report = mapVillages(
      [
        village({ code: '91.06.12.1014', name: 'Anjareuw', districtName: 'Samofa', postalCode: '98551' }),
        village({ code: '91.06.12.2016', name: 'Anjareuw', districtName: 'Samofa', postalCode: '98551' }),
      ],
      [dest({ id: 7001, districtName: 'SAMOFA', subdistrictName: 'ANJAREUW', zipCode: '98551' })],
    );

    // One RO row cannot serve two distinct villages: both match it, so the id
    // ends up claimed twice and the run is blocked.
    expect(report.duplicateIds).toEqual([7001]);
    expect(report.safeToApply).toBe(false);
    expect(applicableMappings(report)).toEqual([]);
  });
});

// ----------------------------------------------------------------------- 8

describe('spelling variation is reviewed, not guessed', () => {
  it('DARWATI (RajaOngkir) does NOT auto-match Derwati (Massular)', () => {
    const report = mapVillages(
      [village({ code: '32.73.23.1004', name: 'Derwati' })],
      [dest({ id: 4933, subdistrictName: 'DARWATI' })],
    );

    expect(report.matches[0].outcome).toBe('NOT_FOUND');
    expect(applicableMappings(report)).toEqual([]);
  });

  it('normalisation stays conservative — no prefix stripping, no edit distance', () => {
    expect(normalizeName('  Kel.  Cipamokolan ')).toBe('KEL CIPAMOKOLAN');
    expect(normalizeName('Desa Derwati')).not.toBe(normalizeName('Derwati'));
    expect(normalizeName('DARWATI')).not.toBe(normalizeName('Derwati'));
  });

  it('a curated province alias is applied, and it is data not a rule', () => {
    const report = mapVillages(
      [village({ provinceName: 'Aceh', districtName: 'Baiturrahman', name: 'Peuniti', postalCode: '23241' })],
      [dest({ id: 5100, provinceName: 'NANGGROE ACEH DARUSSALAM (NAD)', districtName: 'BAITURRAHMAN', subdistrictName: 'PEUNITI', zipCode: '23241' })],
      { Aceh: 'NANGGROE ACEH DARUSSALAM (NAD)' },
    );

    expect(report.matches[0]).toMatchObject({ outcome: 'MATCHED', rajaOngkirId: 5100 });
  });

  it('without the alias the same row is simply NOT_FOUND', () => {
    const report = mapVillages(
      [village({ provinceName: 'Aceh', districtName: 'Baiturrahman', name: 'Peuniti' })],
      [dest({ id: 5100, provinceName: 'NANGGROE ACEH DARUSSALAM (NAD)', districtName: 'BAITURRAHMAN', subdistrictName: 'PEUNITI' })],
    );

    expect(report.matches[0].outcome).toBe('NOT_FOUND');
  });
});

// -------------------------------------------------------------- 9, 10, 12

describe('unmapped villages stay null', () => {
  it('no candidate => NOT_FOUND and nothing emitted', () => {
    const report = mapVillages([village()], []);

    expect(report).toMatchObject({ total: 1, matched: 0, notFound: 1 });
    expect(applicableMappings(report)).toEqual([]);
    // Not a blocker: an unmapped village simply yields no JNE quote.
    expect(report.safeToApply).toBe(true);
  });

  it('still maps the villages it CAN identify', () => {
    const report = mapVillages(
      [village(), village({ code: '32.73.23.1004', name: 'Derwati' })],
      [dest()],
    );

    expect(report.matched).toBe(1);
    expect(report.notFound).toBe(1);
    expect(applicableMappings(report)).toEqual([{ code: '32.73.23.1003', rajaOngkirId: 4932 }]);
  });

  it('there is no district-level fallback anywhere in the tool', () => {
    // A district-wide RO row must not satisfy a village: the subdistrict name
    // still has to match, so a district id can never stand in for one.
    const report = mapVillages([village()], [dest({ subdistrictName: 'RANCASARI' })]);

    expect(report.matches[0].outcome).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------- determinism

describe('the mapping is deterministic', () => {
  it('produces identical output when run twice', () => {
    const m = [village(), village({ code: '32.73.23.1004', name: 'Derwati' })];
    const r = [dest(), dest({ id: 4933, subdistrictName: 'DERWATI' })];

    expect(JSON.stringify(mapVillages(m, r))).toBe(JSON.stringify(mapVillages(m, r)));
  });

  it('emits the same rows regardless of input ordering', () => {
    const a = mapVillages(
      [village(), village({ code: '32.73.23.1004', name: 'Derwati' })],
      [dest(), dest({ id: 4933, subdistrictName: 'DERWATI' })],
    );
    const b = mapVillages(
      [village({ code: '32.73.23.1004', name: 'Derwati' }), village()],
      [dest({ id: 4933, subdistrictName: 'DERWATI' }), dest()],
    );

    expect(applicableMappings(a)).toEqual(applicableMappings(b));
  });

  it('the sample report shows outcome, id and reason', () => {
    const report = mapVillages([village({ postalCode: '40293' })], [dest()]);

    const text = formatSample(report);
    expect(text).toContain('REVIEW_REQUIRED');
    expect(text).toContain('postal code differs');
    expect(text).toContain('safeToApply=true');
  });
});
