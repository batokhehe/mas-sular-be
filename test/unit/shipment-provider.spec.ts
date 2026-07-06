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
    paxel: { enabled: paxelEnabled, baseUrl: 'https://paxel.test', apiKey: 'secret', timeoutMs: 500, maxRetry },
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

const INPUT: CreateShipmentInput = {
  orderId: 'o1',
  orderNumber: 'INV-1',
  service: 'REG',
  weightGram: 1500,
  origin: { name: 'Pusat', postalCode: '40111', latitude: -6.9, longitude: 107.6 },
  destination: { name: 'Budi', phone: '628123', addressDetail: 'Jl. Test 1', postalCode: '40131', latitude: -6.8, longitude: 107.5 },
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
    http.mockResolvedValue(res(200, JSON.stringify({ data: { id: 'PX-99', tracking_number: 'PAXEL123', status: 'CREATED' } })));
    const result = await provider.createShipment(INPUT);
    expect(result.trackingNumber).toBe('PAXEL123');
    expect(result.providerShipmentId).toBe('PX-99');
    expect(result.status).toBe(ShipmentStatus.CREATED);
  });

  it('throws PermanentError when disabled (no HTTP)', async () => {
    const { provider, http } = build(false);
    await expect(provider.createShipment(INPUT)).rejects.toBeInstanceOf(PermanentError);
    expect(http).not.toHaveBeenCalled();
  });

  it('classifies 5xx as TransientError and retries', async () => {
    const { provider, http } = build();
    http.mockResolvedValue(res(502, 'bad gateway'));
    await expect(provider.createShipment(INPUT)).rejects.toBeInstanceOf(TransientError);
    expect(http).toHaveBeenCalledTimes(2); // maxRetry 1 → 2 attempts
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
