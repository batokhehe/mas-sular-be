import { ShipmentStatus } from '@prisma/client';
import { PaxelShipmentProvider } from '../../src/modules/shipment/infrastructure/providers/paxel-shipment.provider';
import { JneShipmentProvider } from '../../src/modules/shipment/infrastructure/providers/jne-shipment.provider';
import { PermanentError, TransientError } from '../../src/modules/shipping/domain/shipping-errors';
import { ShippingConfig } from '../../src/modules/shipping/shipping.config';
import { ShippingHttpResponse } from '../../src/modules/shipping/infrastructure/http/shipping-http-client';
import { CreateShipmentInput } from '../../src/modules/shipment/domain/shipment-provider.interface';

function config(paxelEnabled: boolean, jneEnabled: boolean, maxRetry = 1): ShippingConfig {
  return {
    originPostalCode: '40111',
    allowMockRates: false,
    // RajaOngkir is the JNE rate source (PAXELBOX-45); disabled here so these
    // pre-existing cases keep exercising exactly what they always did.
    rajaongkir: { enabled: false, baseUrl: 'https://rajaongkir.invalid/api/v1', timeoutMs: 1000, maxRetry: 1 },
    paxel: {
      enabled: paxelEnabled,
      baseUrl: 'https://paxel.test',
      apiKey: 'secret',
      apiSecret: 'secret-signing-value',
      originPhone: '081212121212',
      originNote: 'gerbang samping',
      timeoutMs: 500,
      maxRetry,
      defaultDimension: '30x35x20',
      needInsurance: false,
    },
    jne: {
      enabled: jneEnabled,
      baseUrl: 'https://jne.test',
      apiKey: 'secret',
      username: 'store',
      originCode: 'BDO10000',
      timeoutMs: 500,
      maxRetry,
    },
  };
}

function res(status: number, body: string): ShippingHttpResponse {
  return { status, text: async () => body, headers: { get: () => null } };
}

/**
 * A JNE-shaped input: the minimum the older provider needs. Paxel requires far
 * more (see PAXEL_INPUT), which is itself the point — the two couriers do not
 * share a payload.
 */
const INPUT: CreateShipmentInput = {
  orderId: 'o1',
  orderNumber: 'INV-1',
  service: 'REG',
  weightGram: 1500,
  origin: { name: 'Pusat', postalCode: '40111', latitude: -6.9, longitude: 107.6 },
  destination: { name: 'Budi', phone: '628123', addressDetail: 'Jl. Test 1', postalCode: '40131', latitude: -6.8, longitude: 107.5 },
};

/** Everything Paxel's documented create contract requires. */
const PAXEL_INPUT: CreateShipmentInput = {
  ...INPUT,
  service: 'PAXEL_REGULAR',
  invoiceValue: 250000,
  paymentMethod: 'BANK_TRANSFER',
  pickupAtIso: '2026-09-01T10:00:00.000Z',
  origin: {
    ...INPUT.origin,
    addressDetail: 'Jl. Outlet No.1',
    province: 'Jawa Barat',
    city: 'Kota Bandung',
    district: 'Coblong',
    village: 'Dago',
  },
  destination: {
    ...INPUT.destination,
    note: 'pagar hijau',
    province: 'Jawa Barat',
    city: 'Kota Bandung',
    district: 'Sukajadi',
    village: 'Pasteur',
  },
  items: [
    {
      code: 'SKU-1',
      name: 'Bakso',
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
};

describe('PaxelShipmentProvider', () => {
  function build(enabled = true) {
    const provider = new PaxelShipmentProvider(config(enabled, false));
    const http = jest.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).http = http;
    return { provider, http };
  }

  it('maps a successful create response to tracking + providerShipmentId', async () => {
    const { provider, http } = build();
    // Paxel returns ONLY airwaybill_code — no separate id, no status.
    http.mockResolvedValue(res(200, JSON.stringify({ data: { airwaybill_code: 'MERCHANT-20200224-1-HB4OBT' } })));
    const result = await provider.createShipment(PAXEL_INPUT);
    expect(result.trackingNumber).toBe('MERCHANT-20200224-1-HB4OBT');
    expect(result.providerShipmentId).toBe('MERCHANT-20200224-1-HB4OBT');
    expect(result.status).toBe(ShipmentStatus.CREATED);
  });

  it('throws PermanentError when disabled (no HTTP)', async () => {
    const { provider, http } = build(false);
    await expect(provider.createShipment(PAXEL_INPUT)).rejects.toBeInstanceOf(PermanentError);
    expect(http).not.toHaveBeenCalled();
  });

  it('does NOT retry a 5xx create — Paxel has no idempotency key', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(502, 'bad gateway'));
    // Still a TransientError for the caller, but issued exactly ONCE: retrying a
    // create whose response was lost can mint a second airwaybill.
    await expect(provider.createShipment(PAXEL_INPUT)).rejects.toBeInstanceOf(TransientError);
    expect(http).toHaveBeenCalledTimes(1);
  });
});

describe('JneShipmentProvider', () => {
  function build(enabled = true) {
    const provider = new JneShipmentProvider(config(false, enabled));
    const http = jest.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).http = http;
    return { provider, http };
  }

  it('maps a successful generate response to a cnote tracking number', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(200, JSON.stringify({ detail: [{ cnote_no: 'JNE00099', status: 'SUCCESS' }] })));
    const result = await provider.createShipment(INPUT);
    expect(result.trackingNumber).toBe('JNE00099');
    expect(result.status).toBe(ShipmentStatus.CREATED);
    const body = String(http.mock.calls[0][1].body);
    expect(body).toContain('api_key=secret');
    expect(body).toContain('origin_code=BDO10000');
  });

  it('classifies 4xx as PermanentError (no retry)', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(400, 'bad'));
    await expect(provider.createShipment(INPUT)).rejects.toBeInstanceOf(PermanentError);
    expect(http).toHaveBeenCalledTimes(1);
  });
});
