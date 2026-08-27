import { PaxelProvider } from '../../src/modules/shipping/infrastructure/providers/paxel.provider';
import { selectPaxelBox } from '../../src/modules/shipping/domain/paxel-box';
import { paxelBoxRateDimension } from '../../src/modules/shipping/infrastructure/providers/paxel-box-dimension';
import { ShippingRateRequest } from '../../src/modules/shipping/domain/shipping-provider.interface';

/**
 * PAXELBOX-17: quantities past L (>20) have no supported box, because XL is out
 * of scope. `selectPaxelBox` returns null for them, and Paxel must then offer
 * nothing at all.
 *
 * The subtle part is the THREE states of `request.paxelBoxSize`:
 *
 *   absent -> caller computed no box (JNE-only, legacy) -> default dimension
 *   a size -> that box drives the RATE dimension
 *   null   -> computed, and nothing fits -> Paxel returns no quotes
 *
 * Before the fix, null/absent both fell through to PAXEL_DEFAULT_DIMENSION, so
 * an unshippable 21-item order would have been quoted a price for a box it does
 * not fit. These tests pin all three.
 */

const CONFIG = {
  paxel: {
    enabled: true,
    baseUrl: 'https://stage-commerce-api.paxel.co/v1',
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    timeoutMs: 5000,
    defaultDimension: '10x10x10',
    originPhone: '628',
    originNote: 'note',
  },
  allowMockRates: false,
} as never;

const BASE: ShippingRateRequest = {
  originPostalCode: '40111',
  destinationPostalCode: '40562',
  weightGram: 200,
};

/** Captures outgoing bodies without any network. */
function buildProvider() {
  const provider = new PaxelProvider(CONFIG);
  const sent: Array<Record<string, unknown>> = [];
  (provider as unknown as { http: unknown }).http = async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body));
    return {
      status: 200,
      headers: new Headers(),
      text: async () =>
        JSON.stringify({ data: { fixed_price: 44000, fixed_size: 'custom' }, message: 'ok' }),
    };
  };
  return { provider, sent };
}

describe('Paxel is unavailable when the order fits no box', () => {
  it('returns no quotes and makes no HTTP call for paxelBoxSize === null', async () => {
    const { provider, sent } = buildProvider();

    const quotes = await provider.getRates({ ...BASE, paxelBoxSize: null });

    expect(quotes).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it('never sends an XL dimension for a >20 quantity', async () => {
    const { provider, sent } = buildProvider();

    // The real checkout composition: quantity -> box -> request.
    const quotes = await provider.getRates({ ...BASE, paxelBoxSize: selectPaxelBox(21) });

    expect(quotes).toEqual([]);
    expect(sent).toHaveLength(0);
    // Nothing resembling the XL carton was ever built.
    expect(JSON.stringify(sent)).not.toContain('59x48x48');
  });

  // The POSITIVE paths — each supported box producing its dimension, and an
  // ABSENT box still falling back to PAXEL_DEFAULT_DIMENSION — are already
  // covered in paxel.provider.spec.ts, which owns the full HTTP harness. They
  // are not duplicated here with a thinner fake.
});

describe('the selector and the dimension builder agree', () => {
  it('every selectable quantity yields a dimension; past L yields no box', () => {
    for (const quantity of [1, 2, 3, 4, 10, 11, 20]) {
      const box = selectPaxelBox(quantity);
      if (box === null) throw new Error(`expected a box for ${quantity}`);
      expect(paxelBoxRateDimension(box)).toMatch(/^\d+x48x48$/);
      expect(box).not.toBe('XL');
    }
    for (const quantity of [21, 22, 50]) {
      expect(selectPaxelBox(quantity)).toBeNull();
    }
  });
});
