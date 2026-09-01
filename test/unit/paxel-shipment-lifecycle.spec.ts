import { ShipmentStatus } from '@prisma/client';
import {
  DEFAULT_CANCELLATION_REASON,
  PaxelShipmentProvider,
} from '../../src/modules/shipment/infrastructure/providers/paxel-shipment.provider';
import { paxelCancelSignature } from '../../src/modules/shipment/infrastructure/providers/paxel-signature';
import { PermanentError, TransientError } from '../../src/modules/shipping/domain/shipping-errors';
import { ShippingConfig } from '../../src/modules/shipping/shipping.config';
import { ShippingHttpRequest, ShippingHttpResponse } from '../../src/modules/shipping/infrastructure/http/shipping-http-client';

/**
 * Paxel cancel + tracking (PAXEL-B1), against the contract in the Paxel
 * eCommerce API Postman collection.
 *
 * What the previous implementation got wrong and these tests now pin: Bearer
 * auth instead of X-Paxel-API-Key, no signature at all on cancel, and a
 * `/v1/tracking/:no` endpoint that does not exist — tracking is a shipment
 * lookup at `/shipments/:airwaybill_code` reading `data.latest_status`.
 *
 * Shipment CREATE is deliberately not covered here; it is deferred to B2.
 */

const API_KEY = 'test-api-key-not-a-real-secret';
const API_SECRET = 'test-api-secret-not-a-real-secret';
const AWB = 'MERCHANT-20200224-1-HB4OBT';

function config(over: Partial<{ enabled: boolean; maxRetry: number }> = {}): ShippingConfig {
  return {
    originPostalCode: '40111',
    allowMockRates: false,
    // RajaOngkir is the JNE rate source (PAXELBOX-45); disabled here so these
    // pre-existing cases keep exercising exactly what they always did.
    rajaongkir: { enabled: false, baseUrl: 'https://rajaongkir.invalid/api/v1', timeoutMs: 1000, maxRetry: 1 },
    paxel: {
      enabled: over.enabled ?? true,
      baseUrl: 'https://stage-commerce-api.paxel.test/v1',
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      timeoutMs: 500,
      maxRetry: over.maxRetry ?? 0,
      defaultDimension: '30x35x20', needInsurance: false,
    },
    jne: { enabled: false, baseUrl: 'https://jne.test', timeoutMs: 500, maxRetry: 0 },
  };
}

function res(status: number, body: string): ShippingHttpResponse {
  return { status, text: async () => body, headers: { get: () => null } };
}

interface Call {
  url: string;
  init: ShippingHttpRequest;
}

function build(cfg = config(), responder: (call: Call) => ShippingHttpResponse = () => res(200, '{"status_code":200,"message":"OK"}')) {
  const calls: Call[] = [];
  const provider = new PaxelShipmentProvider(cfg);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (provider as any).http = async (url: string, init: ShippingHttpRequest) => {
    calls.push({ url, init });
    return responder({ url, init });
  };
  return { provider, calls };
}

/** A tracking payload shaped like the collection's saved example. */
function detail(latestStatus: string): string {
  return JSON.stringify({
    status_code: 200,
    message: 'OK',
    data: {
      airwaybill_code: AWB,
      invoice_number: 'A8HGK893J8',
      latest_status: latestStatus,
      logs: [{ created_datetime: '2018-04-23 12:05:10', note: 'x' }],
    },
  });
}

// ==================================================================== cancel ==

describe('PaxelShipmentProvider.cancelShipment', () => {
  it('POSTs to /shipments/:awb/cancel with the documented body', async () => {
    const { provider, calls } = build();
    await provider.cancelShipment(AWB, 'penjual kehabisan stok');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://stage-commerce-api.paxel.test/v1/shipments/${encodeURIComponent(AWB)}/cancel`);
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ cancellation_reason: 'penjual kehabisan stok' });
  });

  it('authenticates with X-Paxel-API-Key and signs with X-Paxel-Signature, never Bearer', async () => {
    const { provider, calls } = build();
    await provider.cancelShipment(AWB, 'penjual kehabisan stok');

    const headers = calls[0].init.headers;
    expect(headers['X-Paxel-API-Key']).toBe(API_KEY);
    expect(headers['X-Paxel-Signature']).toBe(paxelCancelSignature(AWB, 'penjual kehabisan stok', API_SECRET));
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBeUndefined();
    expect(JSON.stringify(headers)).not.toMatch(/Bearer/i);
  });

  it('signs the reason it actually sends when the caller supplies none', async () => {
    const { provider, calls } = build();
    await provider.cancelShipment(AWB);

    const body = JSON.parse(calls[0].init.body as string);
    expect(body.cancellation_reason).toBe(DEFAULT_CANCELLATION_REASON);
    expect(calls[0].init.headers['X-Paxel-Signature']).toBe(
      paxelCancelSignature(AWB, DEFAULT_CANCELLATION_REASON, API_SECRET),
    );
  });

  it('never sends a blank reason — Paxel requires one and it feeds the signature', async () => {
    const { provider, calls } = build();
    await provider.cancelShipment(AWB, '   ');
    expect(JSON.parse(calls[0].init.body as string).cancellation_reason).toBe(DEFAULT_CANCELLATION_REASON);
  });

  it('propagates a 4xx as PermanentError — a refused cancellation is not a success', async () => {
    const { provider } = build(config(), () => res(400, '{"message":"cannot cancel"}'));
    await expect(provider.cancelShipment(AWB, 'reason')).rejects.toBeInstanceOf(PermanentError);
  });

  it('propagates a 5xx as TransientError after retrying', async () => {
    const { provider, calls } = build(config({ maxRetry: 1 }), () => res(503, 'upstream down'));
    await expect(provider.cancelShipment(AWB, 'reason')).rejects.toBeInstanceOf(TransientError);
    expect(calls).toHaveLength(2);
  });

  it('propagates a timeout/network failure as TransientError', async () => {
    const provider = new PaxelShipmentProvider(config({ maxRetry: 1 }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).http = async () => {
      throw new Error('AbortError');
    };
    await expect(provider.cancelShipment(AWB, 'reason')).rejects.toBeInstanceOf(TransientError);
  });

  it('accepts a 2xx with an unparseable body — cancellation is about the status code', async () => {
    const { provider } = build(config(), () => res(200, 'not-json'));
    await expect(provider.cancelShipment(AWB, 'reason')).resolves.toBeUndefined();
  });

  it('makes no HTTP call when Paxel is disabled', async () => {
    const { provider, calls } = build(config({ enabled: false }));
    await expect(provider.cancelShipment(AWB, 'reason')).rejects.toBeInstanceOf(PermanentError);
    expect(calls).toHaveLength(0);
  });
});

// ================================================================== tracking ==

describe('PaxelShipmentProvider tracking', () => {
  it('GETs /shipments/:awb with the API key and no Bearer', async () => {
    const { provider, calls } = build(config(), () => res(200, detail('PDO')));
    await provider.trackShipment(AWB);

    expect(calls[0].url).toBe(`https://stage-commerce-api.paxel.test/v1/shipments/${encodeURIComponent(AWB)}`);
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.headers['X-Paxel-API-Key']).toBe(API_KEY);
    expect(calls[0].init.headers.Authorization).toBeUndefined();
    // The old guessed endpoint must be gone.
    expect(calls[0].url).not.toContain('/tracking/');
  });

  it('reads data.latest_status, not data.status', async () => {
    const { provider } = build(config(), () =>
      res(200, JSON.stringify({ data: { status: 'DELIVERED', latest_status: 'RTP' } })),
    );
    // `status` is the field the old guessed contract used; latest_status wins.
    expect((await provider.trackShipment(AWB)).status).toBe(ShipmentStatus.WAITING_PICKUP);
  });

  it('exposes the raw provider status unmapped for the status mapper', async () => {
    const { provider } = build(config(), () => res(200, detail('PAPV')));
    const raw = await provider.trackShipmentRaw(AWB);
    expect(raw.providerStatus).toBe('PAPV');
    expect(raw.rawPayload).toMatchObject({ data: { airwaybill_code: AWB } });
  });

  it.each([
    ['CONFIRMED', ShipmentStatus.CREATED],
    ['RTP', ShipmentStatus.WAITING_PICKUP],
    ['COL', ShipmentStatus.WAITING_PICKUP],
    ['PAPV', ShipmentStatus.PICKED_UP],
    ['POL', ShipmentStatus.IN_TRANSIT],
    ['POD', ShipmentStatus.OUT_FOR_DELIVERY],
    ['COD', ShipmentStatus.OUT_FOR_DELIVERY],
    ['PDO', ShipmentStatus.DELIVERED],
    ['PRJL', ShipmentStatus.FAILED],
    ['RAP', ShipmentStatus.FAILED],
    ['UNDLM', ShipmentStatus.FAILED],
    ['RTN', ShipmentStatus.FAILED],
    // CCS moved out of the undocumented set: staging cancellation produced it.
    ['CCS', ShipmentStatus.CANCELLED],
  ])('maps the documented status %s to %s', async (paxelStatus, expected) => {
    const { provider } = build(config(), () => res(200, detail(paxelStatus)));
    expect((await provider.trackShipment(AWB)).status).toBe(expected);
  });

  /**
   * CCS is no longer in this set. It was moved to the documented list after a
   * staging cancellation returned 200 and the shipment's latest_status became
   * "CCS" carrying the cancellation_reason we had sent - direct evidence of its
   * meaning rather than an inference from the acronym.
   *
   * The rest stay UNKNOWN deliberately. The locker states are the tempting
   * ones, and guessing wrong would either notify a customer early or mark an
   * undelivered parcel as done.
   */
  it.each(['HAPH', 'FAILED3PL', 'ONHOLD3PL', 'ODL', 'ODLXL', 'POLXL'])(
    'maps the undocumented status %s to UNKNOWN rather than guessing',
    async (paxelStatus) => {
      const { provider } = build(config(), () => res(200, detail(paxelStatus)));
      expect((await provider.trackShipment(AWB)).status).toBe(ShipmentStatus.UNKNOWN);
    },
  );

  it('maps an arbitrary future status to UNKNOWN without throwing', async () => {
    const { provider } = build(config(), () => res(200, detail('SOMETHING_NEW_IN_2027')));
    expect((await provider.trackShipment(AWB)).status).toBe(ShipmentStatus.UNKNOWN);
  });

  it('degrades to UNKNOWN on a malformed body, keeping the raw text', async () => {
    const { provider } = build(config(), () => res(200, 'not-json'));
    const result = await provider.trackShipment(AWB);
    expect(result.status).toBe(ShipmentStatus.UNKNOWN);
    expect(result.rawPayload).toBe('not-json');
  });

  it('degrades to UNKNOWN when latest_status is absent', async () => {
    const { provider } = build(config(), () => res(200, JSON.stringify({ data: { airwaybill_code: AWB } })));
    expect((await provider.trackShipment(AWB)).status).toBe(ShipmentStatus.UNKNOWN);
  });

  it.each([
    [404, PermanentError],
    [400, PermanentError],
    [500, TransientError],
  ])('propagates HTTP %s', async (status, errorType) => {
    const { provider } = build(config(), () => res(status as number, '{"message":"nope"}'));
    await expect(provider.trackShipment(AWB)).rejects.toBeInstanceOf(errorType as never);
  });

  it('propagates a timeout as TransientError', async () => {
    const provider = new PaxelShipmentProvider(config());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).http = async () => {
      throw new Error('AbortError');
    };
    await expect(provider.trackShipment(AWB)).rejects.toBeInstanceOf(TransientError);
  });

  it('makes no HTTP call when Paxel is disabled', async () => {
    const { provider, calls } = build(config({ enabled: false }));
    await expect(provider.trackShipment(AWB)).rejects.toBeInstanceOf(PermanentError);
    expect(calls).toHaveLength(0);
  });
});

// ================================================================== security ==

describe('PaxelShipmentProvider credential and PII safety', () => {
  it('keeps the key, the secret, the signature and the AWB out of logs', async () => {
    const logged: unknown[] = [];
    const { provider } = build(config(), () => res(400, '{"message":"cannot cancel"}'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const logger = (provider as any).logger;
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
        logged.push(...args);
      });
    }

    await expect(provider.cancelShipment(AWB, 'penjual kehabisan stok')).rejects.toBeInstanceOf(PermanentError);

    const dump = JSON.stringify(logged);
    expect(dump).not.toContain(API_KEY);
    expect(dump).not.toContain(API_SECRET);
    expect(dump).not.toContain(paxelCancelSignature(AWB, 'penjual kehabisan stok', API_SECRET));
    expect(dump).not.toContain(AWB);
    jest.restoreAllMocks();
  });

  it('does not put the secret or signature into the thrown error', async () => {
    const { provider } = build(config(), () => res(400, '{"message":"cannot cancel"}'));
    await expect(provider.cancelShipment(AWB, 'reason')).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining(API_SECRET) as unknown as string,
      }),
    );
  });
});
