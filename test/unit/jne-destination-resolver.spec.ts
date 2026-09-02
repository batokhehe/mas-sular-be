/**
 * PAXELBOX-61S — runtime District -> JNE destination code.
 *
 * The resolver puts every condition in the WHERE clause, so these tests assert
 * on the QUERY as well as the answer: a row that should never be considered must
 * not merely be discarded after loading, it must never be asked for.
 */

import { JneDestinationResolver } from '../../src/modules/shipping/infrastructure/jne-destination.resolver';

type Row = { districtId: string; status: string; isActive: boolean; code: string; kind: string; locationActive: boolean };

/**
 * Stands in for Prisma, applying the same filters findFirst would. Also records
 * the WHERE it was given so the tests can prove the filters are pushed down.
 */
function prismaWith(rows: Row[]) {
  const seen: Array<Record<string, unknown>> = [];
  return {
    seen,
    client: {
      jneDistrictMapping: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) => {
          seen.push(where);
          const loc = where.jneLocation as { kind?: string; isActive?: boolean } | undefined;
          const hit = rows.find(
            (r) =>
              r.districtId === where.districtId &&
              (where.isActive === undefined || r.isActive === where.isActive) &&
              (where.status === undefined || r.status === where.status) &&
              (loc?.kind === undefined || r.kind === loc.kind) &&
              (loc?.isActive === undefined || r.locationActive === loc.isActive),
          );
          return hit ? { jneLocation: { code: hit.code } } : null;
        },
      },
    } as never,
  };
}

const row = (over: Partial<Row> = {}): Row => ({
  districtId: 'dist-andir',
  status: 'MATCHED',
  isActive: true,
  code: 'BDO10041',
  kind: 'DESTINATION',
  locationActive: true,
  ...over,
});

const resolverFor = (rows: Row[]) => {
  const p = prismaWith(rows);
  return { resolver: new JneDestinationResolver(p.client), seen: p.seen };
};

describe('JneDestinationResolver', () => {
  it('resolves a MATCHED, active district to its JNE destination code', async () => {
    const { resolver } = resolverFor([row()]);
    await expect(resolver.resolve('dist-andir')).resolves.toBe('BDO10041');
  });

  it('fails closed when the district has no mapping at all', async () => {
    const { resolver } = resolverFor([]);
    await expect(resolver.resolve('dist-unmapped')).resolves.toBeNull();
  });

  it('fails closed on an absent district id rather than querying for undefined', async () => {
    const { resolver, seen } = resolverFor([row()]);
    await expect(resolver.resolve(undefined)).resolves.toBeNull();
    expect(seen).toHaveLength(0);
  });

  describe('statuses that are not an approval', () => {
    for (const status of ['REVIEW_REQUIRED', 'AMBIGUOUS', 'NOT_FOUND']) {
      it(`rejects ${status}`, async () => {
        const { resolver } = resolverFor([row({ status })]);
        await expect(resolver.resolve('dist-andir')).resolves.toBeNull();
      });
    }
  });

  it('rejects an inactive mapping', async () => {
    const { resolver } = resolverFor([row({ isActive: false })]);
    await expect(resolver.resolve('dist-andir')).resolves.toBeNull();
  });

  it('rejects a mapping pointing at an inactive JneLocation', async () => {
    const { resolver } = resolverFor([row({ locationActive: false })]);
    await expect(resolver.resolve('dist-andir')).resolves.toBeNull();
  });

  describe('namespace safety', () => {
    it('never accepts an ORIGIN row as a destination', async () => {
      const { resolver } = resolverFor([row({ kind: 'ORIGIN' })]);
      await expect(resolver.resolve('dist-andir')).resolves.toBeNull();
    });

    /**
     * 601 of JNE's 614 origin codes also exist as destination codes, as separate
     * rows sharing one code (PAXELBOX-61P). Only the DESTINATION row may answer.
     */
    it('resolves only the DESTINATION row when a code exists in both namespaces', async () => {
      const { resolver } = resolverFor([
        row({ code: 'BDO10000', kind: 'ORIGIN' }),
        row({ code: 'BDO10000', kind: 'DESTINATION' }),
      ]);
      await expect(resolver.resolve('dist-andir')).resolves.toBe('BDO10000');
    });

    it('pushes kind/status/active down into the query, not into post-filtering', async () => {
      const { resolver, seen } = resolverFor([row()]);
      await resolver.resolve('dist-andir');
      expect(seen[0]).toEqual({
        districtId: 'dist-andir',
        isActive: true,
        status: 'MATCHED',
        jneLocation: { kind: 'DESTINATION', isActive: true },
      });
    });

    it('never queries by JNE code alone', async () => {
      const { resolver, seen } = resolverFor([row()]);
      await resolver.resolve('dist-andir');
      expect(seen[0]).not.toHaveProperty('code');
      expect(JSON.stringify(seen[0])).toContain('DESTINATION');
    });
  });
});
