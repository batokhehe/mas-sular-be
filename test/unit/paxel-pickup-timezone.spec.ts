import { execFileSync } from 'child_process';
import * as path from 'path';
import { Prisma } from '@prisma/client';
import {
  formatPaxelDatetime,
  PAXEL_BUSINESS_TIMEZONE,
} from '../../src/modules/shipment/infrastructure/providers/paxel-datetime';
import { PaxelShipmentProvider } from '../../src/modules/shipment/infrastructure/providers/paxel-shipment.provider';
import { readPickupDatetime, withPickupDatetime } from '../../src/modules/shipment/shipment-metadata';
import { CreateShipmentInput } from '../../src/modules/shipment/domain/shipment-provider.interface';
import { PermanentError } from '../../src/modules/shipping/domain/shipping-errors';
import { ShippingConfig } from '../../src/modules/shipping/shipping.config';
import { ShippingHttpRequest, ShippingHttpResponse } from '../../src/modules/shipping/infrastructure/http/shipping-http-client';

/**
 * Paxel pickup_datetime timezone safety.
 *
 * The defect these tests pin was found against real Paxel staging: the admin
 * selects 2026-08-24 10:00 WIB, the browser sends that instant as ISO/UTC
 * (2026-08-24T03:00:00Z), and the old formatter rendered it with
 * Date#getHours(). That reads the PROCESS timezone — Asia/Jakarta on a
 * developer machine, but UTC inside the container, because no TZ is set in any
 * Dockerfile. Production therefore sent "2026-08-24 03:00:00".
 *
 * Paxel accepted that silently: HTTP 200, a real airwaybill_code, and a pickup
 * window of 08:00-10:00 instead of the 10:00-12:00 the operator chose. Nothing
 * failed, so nothing surfaced it — which is why these tests assert absolute
 * literals, and run the real module in a child process whose timezone genuinely
 * differs, rather than deriving an expectation from the same clock under test.
 */

/** The admin's selection: Monday 2026-08-24, 10:00 in Asia/Jakarta. */
const ADMIN_PICKUP_ISO = '2026-08-24T03:00:00.000Z';
const EXPECTED_WIRE = '2026-08-24 10:00:00';

const BACKEND_ROOT = path.resolve(__dirname, '../..');
const DATETIME_MODULE = path.resolve(
  __dirname,
  '../../src/modules/shipment/infrastructure/providers/paxel-datetime.ts',
);

/**
 * Runs a snippet in a CHILD process whose timezone really is `tz`.
 *
 * Mutating process.env.TZ in-process does not work under Jest — Date keeps the
 * timezone the worker started with, so an in-process "timezone switch" compares
 * a value against itself and proves nothing. The premise of these tests is that
 * the process timezone differs from the business timezone, so the timezone has
 * to be set where it is actually read: at process start.
 */
function runInTimezone(tz: string, snippet: string): Record<string, unknown> {
  const stdout = execFileSync(process.execPath, ['-r', 'tsx/cjs', '-e', snippet], {
    env: { ...process.env, TZ: tz },
    cwd: BACKEND_ROOT,
    encoding: 'utf8',
  });
  return JSON.parse(stdout.trim().split('\n').pop() as string) as Record<string, unknown>;
}

interface FormatProbe {
  tz: string;
  out: string;
  /** What the discarded getHours() implementation would have produced. */
  legacyHour: number;
}

/** Formats ADMIN_PICKUP_ISO through the REAL module, in a process running `tz`. */
function formatUnderTimezone(tz: string): FormatProbe {
  return runInTimezone(
    tz,
    `const { formatPaxelDatetime } = require(${JSON.stringify(DATETIME_MODULE)});
     console.log(JSON.stringify({
       tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
       out: formatPaxelDatetime(${JSON.stringify(ADMIN_PICKUP_ISO)}),
       legacyHour: new Date(${JSON.stringify(ADMIN_PICKUP_ISO)}).getHours(),
     }));`,
  ) as unknown as FormatProbe;
}

describe('formatPaxelDatetime — independent of the process timezone', () => {
  it('states the business timezone explicitly rather than inheriting one', () => {
    expect(PAXEL_BUSINESS_TIMEZONE).toBe('Asia/Jakarta');
  });

  // A. developer host
  it('A: renders 10:00:00 when the process runs in Asia/Jakarta', () => {
    const result = formatUnderTimezone('Asia/Jakarta');
    expect(result.tz).toBe('Asia/Jakarta');
    expect(result.out).toBe(EXPECTED_WIRE);
  }, 60_000);

  // B. production container
  it('B: renders 10:00:00 when the process runs in UTC', () => {
    const result = formatUnderTimezone('UTC');
    // The child really is in UTC, and the discarded approach would have said 3.
    expect(result.tz).toBe('UTC');
    expect(result.legacyHour).toBe(3);
    expect(result.out).toBe(EXPECTED_WIRE);
  }, 60_000);

  /**
   * The regression stated as one assertion: the two deployment realities —
   * developer host and production container — must now agree, with the old
   * behaviour shown disagreeing in the very same run so the test cannot pass
   * vacuously.
   */
  it('control: host and container agree now, and provably did not before', () => {
    const jakarta = formatUnderTimezone('Asia/Jakarta');
    const utc = formatUnderTimezone('UTC');

    expect(utc.out).toBe(jakarta.out); // fixed behaviour
    expect(utc.legacyHour).not.toBe(jakarta.legacyHour); // the 7-hour shift, reproduced
    expect(jakarta.legacyHour - utc.legacyHour).toBe(7);
  }, 60_000);

  it('holds in a timezone on the other side of the date line', () => {
    const result = formatUnderTimezone('Pacific/Kiritimati'); // UTC+14
    expect(result.out).toBe(EXPECTED_WIRE);
  }, 60_000);

  it('renders midnight as 00:00:00, never 24:00:00', () => {
    // 2026-08-23T17:00:00Z is exactly midnight in Asia/Jakarta (UTC+7).
    expect(formatPaxelDatetime('2026-08-23T17:00:00.000Z')).toBe('2026-08-24 00:00:00');
  });

  it('crosses the date boundary in Jakarta terms, not the host’s', () => {
    // 2026-08-24T18:00:00Z is 2026-08-25 01:00 in Jakarta — a different DAY.
    expect(formatPaxelDatetime('2026-08-24T18:00:00.000Z')).toBe('2026-08-25 01:00:00');
  });

  it('rejects an unparseable instant rather than sending a malformed slot', () => {
    expect(() => formatPaxelDatetime('not-a-date')).toThrow(PermanentError);
  });
});

/**
 * withPickupDatetime returns the WRITE type (InputJsonValue) and
 * readPickupDatetime takes the READ type (JsonValue). Crossing that boundary is
 * exactly what the database does between the two calls.
 */
function asStored(value: Prisma.InputJsonValue): Prisma.JsonValue {
  return value as unknown as Prisma.JsonValue;
}

// C. persistence round-trip
describe('C: persisted pickup metadata stays consistent', () => {
  it('stores the ISO instant and re-reads it unchanged', () => {
    const metadata = asStored(withPickupDatetime(null, ADMIN_PICKUP_ISO));
    expect(readPickupDatetime(metadata)).toBe(ADMIN_PICKUP_ISO);
  });

  it('formats the stored instant to the same wire value the admin selected', () => {
    const metadata = asStored(withPickupDatetime({ error: 'previous failure' }, ADMIN_PICKUP_ISO));
    // The earlier failure diagnostics survive the merge.
    expect((metadata as { error?: string }).error).toBe('previous failure');
    expect(formatPaxelDatetime(readPickupDatetime(metadata) as string)).toBe(EXPECTED_WIRE);
  });

  it('keeps metadata timezone-free: the column holds the instant, not a wall clock', () => {
    const metadata = asStored(withPickupDatetime(null, ADMIN_PICKUP_ISO));
    // Nothing Jakarta-shaped is persisted; the conversion happens at the wire edge.
    expect(JSON.stringify(metadata)).toContain(ADMIN_PICKUP_ISO);
    expect(JSON.stringify(metadata)).not.toContain(EXPECTED_WIRE);
  });
});

// D. the value that actually reaches Paxel
describe('D: the Paxel create request carries the Jakarta wall-clock time', () => {
  function config(): ShippingConfig {
    return {
      originPostalCode: '40111',
      allowMockRates: false,
      paxel: {
        enabled: true,
        baseUrl: 'https://stage-commerce-api.paxel.test/v1',
        apiKey: 'test-api-key-not-a-real-secret',
        apiSecret: 'test-api-secret-not-a-real-secret',
        originPhone: '081212121212',
        originNote: 'gerbang samping, tanya shift lead',
        timeoutMs: 500,
        maxRetry: 0,
        defaultDimension: '30x35x20',
        needInsurance: false,
      },
      jne: { enabled: false, baseUrl: 'https://jne.test', timeoutMs: 500, maxRetry: 0 },
    };
  }

  function input(): CreateShipmentInput {
    return {
      orderId: 'order-tz',
      orderNumber: 'BMS-000999',
      service: 'PAXEL_SAMEDAY',
      weightGram: 500,
      invoiceValue: 73000,
      paymentMethod: 'BANK_TRANSFER',
      pickupAtIso: ADMIN_PICKUP_ISO,
      origin: {
        name: 'QA Outlet',
        postalCode: '12210',
        addressDetail: 'Jl. Sultan Iskandar Muda No.6C',
        province: 'DKI Jakarta',
        city: 'Kota Jakarta Selatan',
        district: 'Kebayoran Lama',
        village: 'Kby. Lama Sel',
        latitude: -6.244392,
        longitude: 106.776544,
      },
      destination: {
        name: 'QA Recipient',
        phone: '081200000000',
        addressDetail: 'Muara Karang Blok 7',
        note: 'pagar hijau',
        postalCode: '14270',
        province: 'DKI Jakarta',
        city: 'Kota Jakarta Utara',
        district: 'Koja',
        village: 'Pluit',
        latitude: -6.117664,
        longitude: 106.906349,
      },
      items: [
        {
          code: 'QA-SKU-0001',
          name: 'QA Snack',
          category: 'Makanan',
          quantity: 1,
          unitPrice: 50000,
          weightGram: 500,
          lengthCm: 20,
          widthCm: 20,
          heightCm: 20,
          isFragile: false,
        },
      ],
    };
  }

  it('sends exactly "2026-08-24 10:00:00" in this process', async () => {
    const calls: ShippingHttpRequest[] = [];
    const provider = new PaxelShipmentProvider(config());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).http = async (_url: string, init: ShippingHttpRequest): Promise<ShippingHttpResponse> => {
      calls.push(init);
      return {
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ status_code: 200, message: 'OK', data: { airwaybill_code: 'AWB-TZ-1' } }),
      };
    };

    await provider.createShipment(input());
    expect(JSON.parse(calls[0].body as string).pickup_datetime).toBe(EXPECTED_WIRE);
  });

  /**
   * The same assertion, but with the provider constructed inside a UTC process —
   * the configuration production actually runs. This is the test that would have
   * caught the original defect.
   */
  it('sends exactly "2026-08-24 10:00:00" from a UTC process', () => {
    const result = runInTimezone(
      'UTC',
      `const { PaxelShipmentProvider } = require(${JSON.stringify(
        path.resolve(__dirname, '../../src/modules/shipment/infrastructure/providers/paxel-shipment.provider.ts'),
      )});
       const provider = new PaxelShipmentProvider(${JSON.stringify(config())});
       const calls = [];
       provider.http = async (url, init) => {
         calls.push(init);
         return { status: 200, headers: { get: () => null },
           text: async () => JSON.stringify({ status_code: 200, message: 'OK', data: { airwaybill_code: 'AWB-TZ-2' } }) };
       };
       provider.createShipment(${JSON.stringify(input())}).then(() => {
         console.log(JSON.stringify({
           tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
           pickup_datetime: JSON.parse(calls[0].body).pickup_datetime,
         }));
       });`,
    );

    expect(result.tz).toBe('UTC');
    expect(result.pickup_datetime).toBe(EXPECTED_WIRE);
  }, 60_000);
});
