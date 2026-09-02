/**
 * PAXELBOX-61P — JNE_ORIGIN_CODE validated against JNE's own ORIGIN master.
 *
 * The defect being closed: `BDO10056` sat in JNE_ORIGIN_CODE and passed every
 * check, because the only check was "non-empty". It is a DESTINATION code
 * ("MARGACINTA,BANDUNG") and absent from the origin master. A regex cannot tell
 * the two apart — BDO10056 matches JNE's code shape exactly — so the master is
 * the only thing that can.
 */

import { JneOriginBootValidator } from '../../src/modules/shipment/jne-origin-boot.validator';
import {
  EXPECTED_SANDBOX_ORIGIN_ROWS,
  EXPECTED_SANDBOX_ROWS,
  expectedRowsFor,
  toJneLocationSeeds,
} from '../../prisma/tools/jne-master';

/** The three codes this suite reasons about, from measured evidence. */
const ORIGIN_CODE = 'BDO10000'; // 61L: the one city-level BANDUNG origin
const DESTINATION_ONLY_CODE = 'BDO10056'; // 61L: absent from the origin master
const UNKNOWN_CODE = 'ZZZ99999';

/**
 * Stands in for the JneLocation table. Rows are (code, kind) pairs, which is the
 * whole point: the same code can exist in both namespaces.
 */
function prismaWith(rows: Array<{ code: string; kind: string; isActive?: boolean }>) {
  return {
    jneLocation: {
      count: async ({ where }: { where: { kind: string } }) =>
        rows.filter((r) => r.kind === where.kind).length,
      findFirst: async ({ where }: { where: { code: string; kind: string } }) => {
        const hit = rows.find((r) => r.code === where.code && r.kind === where.kind);
        return hit ? { isActive: hit.isActive ?? true } : null;
      },
    },
  } as never;
}

/** A master shaped like the real one: BDO10000 in both, BDO10056 destination-only. */
const REALISTIC = [
  { code: 'BDO10000', kind: 'ORIGIN' },
  { code: 'BDO10000', kind: 'DESTINATION' },
  { code: 'BDO10056', kind: 'DESTINATION' },
  { code: 'CGK10100', kind: 'DESTINATION' },
];

const validator = (rows: Parameters<typeof prismaWith>[0]) => new JneOriginBootValidator(prismaWith(rows));

describe('JneOriginBootValidator', () => {
  it('accepts a code that exists as an ACTIVE ORIGIN', async () => {
    await expect(
      validator(REALISTIC).validate({ enabled: true, originCode: ORIGIN_CODE }),
    ).resolves.toBeUndefined();
  });

  it('REJECTS a destination-only code — the BDO10056 defect', async () => {
    await expect(validator(REALISTIC).validate({ enabled: true, originCode: DESTINATION_ONLY_CODE })).rejects.toThrow(
      /is not a JNE origin code/,
    );
  });

  it('rejects a code present ONLY in the DESTINATION namespace, even though the namespaces overlap', async () => {
    // BDO10000 is in both; BDO10056 is in one. The validator must consult the
    // ORIGIN namespace alone and never be satisfied by a destination hit.
    await expect(validator(REALISTIC).validate({ enabled: true, originCode: 'CGK10100' })).rejects.toThrow(
      /is not a JNE origin code/,
    );
  });

  it('rejects an unknown code', async () => {
    await expect(validator(REALISTIC).validate({ enabled: true, originCode: UNKNOWN_CODE })).rejects.toThrow(
      /is not a JNE origin code/,
    );
  });

  it('rejects an empty or whitespace origin code', async () => {
    for (const originCode of [undefined, '', '   ']) {
      await expect(validator(REALISTIC).validate({ enabled: true, originCode })).rejects.toThrow(
        /JNE_ORIGIN_CODE is not set/,
      );
    }
  });

  it('rejects an INACTIVE origin row', async () => {
    const rows = [{ code: ORIGIN_CODE, kind: 'ORIGIN', isActive: false }];
    await expect(validator(rows).validate({ enabled: true, originCode: ORIGIN_CODE })).rejects.toThrow(/INACTIVE/);
  });

  it('does not accept a code merely because it matches JNE code format', async () => {
    // BDO10056 is a structurally perfect JNE code. Format is not the question.
    expect(/^[A-Z]{3}\d+$/.test(DESTINATION_ONLY_CODE)).toBe(true);
    await expect(validator(REALISTIC).validate({ enabled: true, originCode: DESTINATION_ONLY_CODE })).rejects.toThrow();
  });

  describe('JNE disabled', () => {
    it('checks nothing at all', async () => {
      // Even a code known to be wrong: a disabled courier sends no origin anywhere.
      await expect(
        validator(REALISTIC).validate({ enabled: false, originCode: DESTINATION_ONLY_CODE }),
      ).resolves.toBeUndefined();
      await expect(validator([]).validate({ enabled: false })).resolves.toBeUndefined();
    });
  });

  describe('when the origin master has not been imported', () => {
    it('WARNS and allows boot rather than claiming the code is wrong', async () => {
      const v = validator([{ code: 'BDO10056', kind: 'DESTINATION' }]);
      const warn = jest.spyOn((v as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation();
      await expect(v.validate({ enabled: true, originCode: DESTINATION_ONLY_CODE })).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not be validated|UNVERIFIED/));
      warn.mockRestore();
    });

    it('tolerates the table not existing yet (migration unapplied)', async () => {
      const missing = {
        jneLocation: {
          count: async () => {
            throw new Error("Table 'app.JneLocation' doesn't exist");
          },
          findFirst: async () => null,
        },
      } as never;
      const v = new JneOriginBootValidator(missing);
      const warn = jest.spyOn((v as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation();
      await expect(v.validate({ enabled: true, originCode: ORIGIN_CODE })).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('does NOT swallow an unrelated database error', async () => {
      const broken = {
        jneLocation: {
          count: async () => {
            throw new Error('connection refused');
          },
          findFirst: async () => null,
        },
      } as never;
      await expect(new JneOriginBootValidator(broken).validate({ enabled: true, originCode: ORIGIN_CODE })).rejects.toThrow(
        /connection refused/,
      );
    });
  });

  it('never puts a credential in its error messages', async () => {
    let message = '';
    try {
      await validator(REALISTIC).validate({ enabled: true, originCode: DESTINATION_ONLY_CODE });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/is not a JNE origin code/);
    expect(message).not.toMatch(/api[_-]?key|password|username|secret/i);
  });
});

describe('per-namespace expected row counts', () => {
  it('guards each master with its own measured size', () => {
    expect(EXPECTED_SANDBOX_ROWS).toBe(8322); // 61C destination snapshot
    expect(EXPECTED_SANDBOX_ORIGIN_ROWS).toBe(614); // 61L origin snapshot
    expect(expectedRowsFor('DESTINATION')).toBe(8322);
    expect(expectedRowsFor('ORIGIN')).toBe(614);
  });

  it('would refuse an origin snapshot sized like a destination one, and vice versa', () => {
    expect(expectedRowsFor('ORIGIN')).not.toBe(expectedRowsFor('DESTINATION'));
  });
});

describe('the transformer carries kind through to the seed', () => {
  const rows = [{ City_Name: 'BANDUNG', City_Code: 'BDO10000' }];
  const at = '2026-09-02T08:15:07.000Z';

  it('stamps ORIGIN when asked, and still preserves rawName verbatim', () => {
    const [seed] = toJneLocationSeeds(rows, { kind: 'ORIGIN', source: 'SANDBOX', sourceFetchedAt: at });
    expect(seed.kind).toBe('ORIGIN');
    expect(seed.rawName).toBe('BANDUNG');
    expect(seed.isActive).toBe(true);
  });

  it('still defaults to DESTINATION, so existing destination behaviour is unchanged', () => {
    const [seed] = toJneLocationSeeds(rows, { source: 'SANDBOX', sourceFetchedAt: at });
    expect(seed.kind).toBe('DESTINATION');
  });

  it('produces seeds that differ ONLY by kind for the same source row', () => {
    const [origin] = toJneLocationSeeds(rows, { kind: 'ORIGIN', source: 'SANDBOX', sourceFetchedAt: at });
    const [destination] = toJneLocationSeeds(rows, { kind: 'DESTINATION', source: 'SANDBOX', sourceFetchedAt: at });
    expect({ ...origin, kind: null }).toEqual({ ...destination, kind: null });
    expect(origin.kind).not.toBe(destination.kind);
  });
});
