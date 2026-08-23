import { ShipmentStatus } from '@prisma/client';
import { PaxelShipmentProvider } from '../../src/modules/shipment/infrastructure/providers/paxel-shipment.provider';
import { paxelCreateSignature } from '../../src/modules/shipment/infrastructure/providers/paxel-signature';
import { CreateShipmentInput } from '../../src/modules/shipment/domain/shipment-provider.interface';
import { PermanentError, TransientError } from '../../src/modules/shipping/domain/shipping-errors';
import { ShippingConfig } from '../../src/modules/shipping/shipping.config';
import { ShippingHttpRequest, ShippingHttpResponse } from '../../src/modules/shipping/infrastructure/http/shipping-http-client';

/**
 * Paxel shipment CREATE (PAXEL-B2b), against the contract in the Paxel eCommerce
 * API Postman collection.
 *
 * Three things here are easy to get wrong and are pinned deliberately:
 *   - create's service_type literals differ from the RATE endpoint's. INSTANT is
 *     "INSTANT" here and "INSTANT GOSEND" there.
 *   - physical values must come from the OrderItem snapshot. Falling back to the
 *     rate envelope or the legacy 500 g placeholder would book a parcel that is
 *     not the one the customer ordered.
 *   - create is never retried. Paxel documents no idempotency key, so a retry
 *     after a lost response can mint a second airwaybill for one order.
 */

const API_KEY = 'test-api-key-not-a-real-secret';
const API_SECRET = 'test-api-secret-not-a-real-secret';
const ORIGIN_PHONE = '081212121212';
const ORIGIN_NOTE = 'gerbang samping, tanya shift lead';

function config(over: Partial<{ enabled: boolean; needInsurance: boolean; maxRetry: number }> = {}): ShippingConfig {
  return {
    originPostalCode: '40111',
    allowMockRates: false,
    paxel: {
      enabled: over.enabled ?? true,
      baseUrl: 'https://stage-commerce-api.paxel.test/v1',
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      originPhone: ORIGIN_PHONE,
      originNote: ORIGIN_NOTE,
      timeoutMs: 500,
      maxRetry: over.maxRetry ?? 2, // deliberately non-zero: create must ignore it
      defaultDimension: '30x35x20',
      needInsurance: over.needInsurance ?? false,
    },
    jne: { enabled: false, baseUrl: 'https://jne.test', timeoutMs: 500, maxRetry: 0 },
  };
}

function res(status: number, body: string): ShippingHttpResponse {
  return { status, text: async () => body, headers: { get: () => null } };
}

const AWB = 'MERCHANT-20200224-1-HB4OBT';
const OK = JSON.stringify({
  message: 'OK',
  status_code: 200,
  data: {
    airwaybill_code: AWB,
    shipping_cost: 30000,
    created_datetime: '2020-02-24 13:48:37',
    estimated_pickup_date: '2020-02-25',
    estimated_arrival_date: '2020-02-25',
  },
});

function input(over: Partial<CreateShipmentInput> = {}): CreateShipmentInput {
  return {
    orderId: 'order-1',
    orderNumber: 'BMS-000123',
    service: 'PAXEL_SAMEDAY',
    weightGram: 900,
    invoiceValue: 250000,
    paymentMethod: 'BANK_TRANSFER',
    pickupAtIso: '2026-09-01T10:30:00.000Z',
    origin: {
      name: 'Bakso Mas Sular Pusat',
      postalCode: '40111',
      addressDetail: 'Jl. Outlet No.1',
      province: 'Jawa Barat',
      city: 'Kota Bandung',
      district: 'Coblong',
      village: 'Dago',
      latitude: -6.9147,
      longitude: 107.6098,
    },
    destination: {
      name: 'Budi Santoso',
      phone: '089191919191',
      addressDetail: 'Jl. Pelanggan No.7',
      note: 'pagar hijau',
      postalCode: '40131',
      province: 'Jawa Barat',
      city: 'Kota Bandung',
      district: 'Sukajadi',
      village: 'Pasteur',
      latitude: -6.9,
      longitude: 107.6,
    },
    items: [
      {
        code: 'SKU-001',
        name: 'Bakso Urat',
        category: 'Makanan',
        quantity: 2,
        unitPrice: 45000,
        weightGram: 450,
        lengthCm: 20,
        widthCm: 15,
        heightCm: 10,
        isFragile: false,
      },
    ],
    ...over,
  };
}

interface Call {
  url: string;
  init: ShippingHttpRequest;
}

function build(cfg = config(), responder: (call: Call) => ShippingHttpResponse = () => res(200, OK)) {
  const calls: Call[] = [];
  const provider = new PaxelShipmentProvider(cfg);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (provider as any).http = async (url: string, init: ShippingHttpRequest) => {
    calls.push({ url, init });
    return responder({ url, init });
  };
  return { provider, calls };
}

const bodyOf = (call: Call) => JSON.parse(call.init.body as string);

// =================================================================== payload ==

describe('Paxel create — request', () => {
  it('POSTs the documented endpoint with key, signature and JSON content type', async () => {
    const { provider, calls } = build();
    await provider.createShipment(input());

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://stage-commerce-api.paxel.test/v1/shipments');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers['X-Paxel-API-Key']).toBe(API_KEY);
    expect(calls[0].init.headers['Content-Type']).toBe('application/json');
    expect(calls[0].init.headers.Authorization).toBeUndefined();
  });

  it('signs over the payload actually sent', async () => {
    const { provider, calls } = build();
    await provider.createShipment(input());
    const body = bodyOf(calls[0]);

    expect(calls[0].init.headers['X-Paxel-Signature']).toBe(
      paxelCreateSignature(
        {
          invoiceNumber: body.invoice_number,
          originName: body.origin.name,
          destinationName: body.destination.name,
          firstItemName: body.items[0].name,
        },
        API_SECRET,
      ),
    );
  });

  it('builds the complete documented body', async () => {
    const { provider, calls } = build();
    await provider.createShipment(input());
    const body = bodyOf(calls[0]);

    expect(body.invoice_number).toBe('BMS-000123');
    expect(body.payment_type).toBe('CRD');
    expect(body.invoice_value).toBe(250000);
    expect(body.need_insurance).toBe(false);
    expect(body.origin).toEqual({
      name: 'Bakso Mas Sular Pusat',
      phone: ORIGIN_PHONE,
      address: 'Jl. Outlet No.1',
      note: ORIGIN_NOTE,
      province: 'Jawa Barat',
      city: 'Kota Bandung',
      district: 'Coblong',
      village: 'Dago',
      zip_code: '40111',
      latitude: -6.9147,
      longitude: 107.6098,
    });
    expect(body.destination).toMatchObject({
      name: 'Budi Santoso',
      phone: '089191919191',
      address: 'Jl. Pelanggan No.7',
      note: 'pagar hijau',
      village: 'Pasteur',
      zip_code: '40131',
    });
    expect(body.items).toEqual([
      {
        code: 'SKU-001',
        name: 'Bakso Urat',
        category: 'Makanan',
        is_fragile: false,
        price: 45000,
        quantity: 2,
        weight: 450,
        length: 20,
        width: 15,
        height: 10,
      },
    ]);
  });

  it('takes item physical values from the snapshot, never the rate envelope or the 500g placeholder', async () => {
    const { provider, calls } = build();
    // weightGram 900 is the legacy parcel placeholder; dimension 30x35x20 is the
    // RATE envelope. Neither may appear in an item.
    await provider.createShipment(input({ weightGram: 900 }));
    const item = bodyOf(calls[0]).items[0];

    expect(item.weight).toBe(450);
    expect(item).toMatchObject({ length: 20, width: 15, height: 10 });
    expect(bodyOf(calls[0])).not.toHaveProperty('dimension');
  });

  it('sends the admin pickup instant formatted in Asia/Jakarta', async () => {
    const { provider, calls } = build();
    // 10:30 UTC is 17:30 in Asia/Jakarta. Asserted as an absolute literal: the
    // previous version of this test derived `expected` with the same
    // host-timezone arithmetic it was checking, so it passed under every
    // timezone and could not have caught the 7-hour production shift.
    await provider.createShipment(input({ pickupAtIso: '2026-09-01T10:30:00.000Z' }));

    expect(bodyOf(calls[0]).pickup_datetime).toBe('2026-09-01 17:30:00');
    expect(bodyOf(calls[0]).pickup_datetime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it.each([
    ['PAXEL_INSTANT', 'INSTANT'],
    ['PAXEL_SAMEDAY', 'SAMEDAY'],
    ['PAXEL_NEXTDAY', 'NEXTDAY'],
    ['PAXEL_REGULAR', 'REGULAR'],
  ])('maps %s to create service_type %s', async (service, expected) => {
    const { provider, calls } = build();
    await provider.createShipment(input({ service }));
    expect(bodyOf(calls[0]).service_type).toBe(expected);
  });

  it('never sends the RATE literal for INSTANT', async () => {
    const { provider, calls } = build();
    await provider.createShipment(input({ service: 'PAXEL_INSTANT' }));
    expect(bodyOf(calls[0]).service_type).not.toBe('INSTANT GOSEND');
  });

  it('rejects an unknown service before any HTTP call', async () => {
    const { provider, calls } = build();
    await expect(provider.createShipment(input({ service: 'PAXEL_TELEPORT' }))).rejects.toBeInstanceOf(PermanentError);
    expect(calls).toHaveLength(0);
  });

  it('sends need_insurance true only when configured', async () => {
    const { provider, calls } = build(config({ needInsurance: true }));
    await provider.createShipment(input());
    expect(bodyOf(calls[0]).need_insurance).toBe(true);
  });
});

// ================================================================ rejections ==

describe('Paxel create — refuses to book rather than guess', () => {
  const noCall = async (over: Partial<CreateShipmentInput>) => {
    const { provider, calls } = build();
    await expect(provider.createShipment(input(over))).rejects.toBeInstanceOf(PermanentError);
    expect(calls).toHaveLength(0);
  };

  it('no pickup time → no HTTP call', () => noCall({ pickupAtIso: undefined }));
  it('no items → no HTTP call', () => noCall({ items: [] }));
  it('no invoice value → no HTTP call', () => noCall({ invoiceValue: undefined }));
  it('zero invoice value → no HTTP call', () => noCall({ invoiceValue: 0 }));

  it.each(['weightGram', 'lengthCm', 'widthCm', 'heightCm'] as const)(
    'missing item %s → no HTTP call, no fabricated value',
    async (field) => {
      const items = [{ ...input().items![0], [field]: null }];
      await noCall({ items });
    },
  );

  it.each([
    ['weightGram', 5001],
    ['lengthCm', 51],
    ['widthCm', 0],
    ['heightCm', 51],
  ])('out-of-range item %s (%p) → no HTTP call', async (field, value) => {
    const items = [{ ...input().items![0], [field]: value }];
    await noCall({ items });
  });

  it.each(['name', 'addressDetail', 'province', 'city', 'district', 'village', 'postalCode'] as const)(
    'missing destination.%s → no HTTP call',
    async (field) => {
      await noCall({ destination: { ...input().destination, [field]: undefined } as never });
    },
  );

  /**
   * destination.note is OPTIONAL, and this was settled against the real API
   * rather than by reading the collection: staging create returned 200 with an
   * airwaybill_code when the key was omitted, sent as "", and sent as null.
   *
   * It matters because Address.notes is nullable, so requiring it made every
   * order without a customer delivery note impossible to book.
   */
  it('books without a destination note, and omits the key rather than sending ""', async () => {
    const { provider, calls } = build();
    const result = await provider.createShipment({
      ...input(),
      destination: { ...input().destination, note: undefined },
    });

    expect(calls).toHaveLength(1);
    const destination = bodyOf(calls[0]).destination;
    expect(destination).not.toHaveProperty('note');
    expect(result.trackingNumber).toBe(AWB);
  });

  it.each([undefined, '', '   '])('treats a blank destination note (%p) as absent', async (note) => {
    const { provider, calls } = build();
    await provider.createShipment({ ...input(), destination: { ...input().destination, note } });
    // An empty string is a value Paxel would store and show a driver as if it
    // were a real instruction; absence is the honest representation.
    expect(bodyOf(calls[0]).destination).not.toHaveProperty('note');
  });

  it('still sends a destination note when the customer wrote one', async () => {
    const { provider, calls } = build();
    await provider.createShipment(input());
    expect(bodyOf(calls[0]).destination.note).toBe('pagar hijau');
  });

  it('missing origin phone configuration → no HTTP call', async () => {
    const cfg = config();
    cfg.paxel.originPhone = undefined;
    const { provider, calls } = build(cfg);
    await expect(provider.createShipment(input())).rejects.toThrow(/PAXEL_ORIGIN_PHONE/);
    expect(calls).toHaveLength(0);
  });

  it('missing origin note configuration → no HTTP call', async () => {
    const cfg = config();
    cfg.paxel.originNote = undefined;
    const { provider, calls } = build(cfg);
    await expect(provider.createShipment(input())).rejects.toThrow(/PAXEL_ORIGIN_NOTE/);
    expect(calls).toHaveLength(0);
  });

  it('a COD order is refused, never silently sent as CRD', async () => {
    const { provider, calls } = build();
    await expect(provider.createShipment(input({ paymentMethod: 'COD' }))).rejects.toThrow(/cash-on-delivery/i);
    expect(calls).toHaveLength(0);
  });

  it('makes no HTTP call when Paxel is disabled', async () => {
    const { provider, calls } = build(config({ enabled: false }));
    await expect(provider.createShipment(input())).rejects.toBeInstanceOf(PermanentError);
    expect(calls).toHaveLength(0);
  });
});

// ================================================================== response ==

describe('Paxel create — response', () => {
  it('persists the airwaybill as both tracking number and provider id, status CREATED', async () => {
    const { provider } = build();
    const result = await provider.createShipment(input());

    expect(result.trackingNumber).toBe(AWB);
    expect(result.providerShipmentId).toBe(AWB);
    expect(result.status).toBe(ShipmentStatus.CREATED);
  });

  it('keeps shipping_cost in the raw payload only — it is not the customer price', async () => {
    const { provider } = build();
    const result = await provider.createShipment(input());
    expect(result.rawPayload).toMatchObject({ data: { shipping_cost: 30000 } });
    // CreateShipmentResult carries no cost field at all, so nothing downstream
    // can mistake the provider's cost for the checkout rate snapshot.
    expect(result).not.toHaveProperty('cost');
  });

  it('fails when the response has no airwaybill_code', async () => {
    const { provider } = build(config(), () => res(200, JSON.stringify({ data: { shipping_cost: 30000 } })));
    await expect(provider.createShipment(input())).rejects.toBeInstanceOf(PermanentError);
  });

  it('fails on a malformed body', async () => {
    const { provider } = build(config(), () => res(200, 'not-json'));
    await expect(provider.createShipment(input())).rejects.toBeInstanceOf(PermanentError);
  });
});

// =============================================================== retry safety ==

describe('Paxel create — never retried', () => {
  it('issues exactly ONE request on 5xx even though maxRetry is 2', async () => {
    const { provider, calls } = build(config({ maxRetry: 2 }), () => res(503, 'upstream down'));
    await expect(provider.createShipment(input())).rejects.toBeInstanceOf(TransientError);
    expect(calls).toHaveLength(1);
  });

  it('issues exactly ONE request on timeout — a lost response may already be a booking', async () => {
    let attempts = 0;
    const provider = new PaxelShipmentProvider(config({ maxRetry: 2 }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).http = async () => {
      attempts += 1;
      throw new Error('AbortError');
    };
    await expect(provider.createShipment(input())).rejects.toBeInstanceOf(TransientError);
    expect(attempts).toBe(1);
  });

  it('does not retry a 4xx either', async () => {
    const { provider, calls } = build(config({ maxRetry: 2 }), () => res(400, '{"message":"bad request"}'));
    await expect(provider.createShipment(input())).rejects.toBeInstanceOf(PermanentError);
    expect(calls).toHaveLength(1);
  });
});

// ================================================================== security ==

describe('Paxel create — credential and PII safety', () => {
  it('logs no key, secret, signature, phone, address, recipient or item name', async () => {
    const logged: unknown[] = [];
    const { provider } = build(config(), () => res(400, '{"message":"bad request"}'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const logger = (provider as any).logger;
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
        logged.push(...args);
      });
    }

    await expect(provider.createShipment(input())).rejects.toBeInstanceOf(PermanentError);

    const dump = JSON.stringify(logged);
    for (const secret of [API_KEY, API_SECRET, ORIGIN_PHONE, '089191919191', 'Jl. Pelanggan No.7', 'Budi Santoso', 'Bakso Urat']) {
      expect(dump).not.toContain(secret);
    }
    jest.restoreAllMocks();
  });
});
