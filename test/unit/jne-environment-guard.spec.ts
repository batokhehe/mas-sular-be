/**
 * PAXELBOX-61K — JNE sandbox/production environment guard.
 *
 * The hazard being closed: JNE consignments are booked by hand, and
 * `trackShipmentRaw`/`cancelShipment` spend `jne.baseUrl` on those real cnotes. An
 * enabled courier pointed at the sandbox therefore answers questions about real
 * shipments with sandbox data and writes the result to a customer's order.
 */

import { validateEnv } from '../../src/common/config/env.validation';
import { JneShipmentProvider } from '../../src/modules/shipment/infrastructure/providers/jne-shipment.provider';
import {
  assertJneEnvironment,
  assertShippingConfigured,
  isJneSandboxUrl,
  loadShippingConfig,
  type JneProviderConfig,
  type ShippingConfig,
} from '../../src/modules/shipping/shipping.config';

const SANDBOX_URL = 'https://apiv2.jne.co.id:10202';
/** Stands in for "some endpoint that is not the sandbox". Never asserted to be JNE's. */
const NON_SANDBOX_URL = 'https://jne.example.internal';

const jne = (over: Partial<JneProviderConfig> = {}): JneProviderConfig => ({
  enabled: true,
  baseUrl: SANDBOX_URL,
  apiKey: 'k',
  username: 'u',
  originCode: 'BDO10000',
  timeoutMs: 500,
  maxRetry: 0,
  ...over,
});

describe('assertJneEnvironment', () => {
  describe('disabled courier', () => {
    it('accepts the sandbox URL and requires no production configuration', () => {
      expect(() => assertJneEnvironment(jne({ enabled: false, baseUrl: SANDBOX_URL }))).not.toThrow();
      expect(() => assertJneEnvironment(jne({ enabled: false, environment: 'production', baseUrl: '' }))).not.toThrow();
    });
  });

  describe('sandbox', () => {
    it('accepts the known sandbox endpoint', () => {
      expect(() => assertJneEnvironment(jne({ environment: 'sandbox', baseUrl: SANDBOX_URL }))).not.toThrow();
    });

    it('treats an ABSENT environment as sandbox, never production', () => {
      const config = jne({ baseUrl: SANDBOX_URL });
      delete config.environment;
      expect(() => assertJneEnvironment(config)).not.toThrow();
    });

    it('does not require a production endpoint', () => {
      expect(() => assertJneEnvironment(jne({ environment: 'sandbox', baseUrl: '' }))).not.toThrow();
    });
  });

  describe('production', () => {
    it('REJECTS the known sandbox endpoint', () => {
      expect(() => assertJneEnvironment(jne({ environment: 'production', baseUrl: SANDBOX_URL }))).toThrow(
        /production but JNE_BASE_URL points to the known sandbox endpoint/,
      );
    });

    it('rejects the sandbox endpoint whatever its casing or trailing path', () => {
      expect(() => assertJneEnvironment(jne({ environment: 'production', baseUrl: 'https://APIV2.JNE.CO.ID:10202' }))).toThrow(
        /known sandbox endpoint/,
      );
      expect(() => assertJneEnvironment(jne({ environment: 'production', baseUrl: `${SANDBOX_URL}/tracing/api` }))).toThrow(
        /known sandbox endpoint/,
      );
    });

    it('rejects a missing base URL rather than inventing a default', () => {
      expect(() => assertJneEnvironment(jne({ environment: 'production', baseUrl: '' }))).toThrow(
        /JNE production configuration is incomplete/,
      );
    });

    /**
     * Deliberately asserts only that a NON-sandbox URL is accepted. The real JNE
     * production endpoint is unknown (PAXELBOX-61J) and this suite must never
     * pretend to know it.
     */
    it('accepts an explicitly configured endpoint that is not the sandbox', () => {
      expect(() => assertJneEnvironment(jne({ environment: 'production', baseUrl: NON_SANDBOX_URL }))).not.toThrow();
    });
  });

  describe('unknown environment values', () => {
    it('rejects rather than falling back', () => {
      for (const value of ['prod', 'Production', 'PRODUCTION', 'staging', '']) {
        expect(() => assertJneEnvironment(jne({ environment: value as never }))).toThrow(
          /JNE_ENVIRONMENT must be "sandbox" or "production"/,
        );
      }
    });
  });

  it('never leaks credentials in its messages', () => {
    const secret = 'super-secret-key';
    const cases: JneProviderConfig[] = [
      jne({ environment: 'production', baseUrl: SANDBOX_URL, apiKey: secret, username: secret }),
      jne({ environment: 'production', baseUrl: '', apiKey: secret, username: secret }),
      jne({ environment: 'nonsense' as never, apiKey: secret, username: secret }),
    ];
    for (const config of cases) {
      let message = '';
      try {
        assertJneEnvironment(config);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).not.toBe('');
      expect(message).not.toContain(secret);
      expect(message).not.toMatch(/api[_-]?key=|password|token=/i);
    }
  });
});

describe('isJneSandboxUrl', () => {
  it('identifies the documented sandbox host:port only', () => {
    expect(isJneSandboxUrl(SANDBOX_URL)).toBe(true);
    // A different port on the same host is NOT the documented sandbox, and the
    // guard must not pretend to recognise it either way.
    expect(isJneSandboxUrl('https://apiv2.jne.co.id:10102')).toBe(false);
    expect(isJneSandboxUrl(NON_SANDBOX_URL)).toBe(false);
    expect(isJneSandboxUrl('not a url')).toBe(false);
  });
});

describe('loadShippingConfig — JNE environment', () => {
  const base = { JNE_ENABLED: 'true', JNE_API_KEY: 'k', JNE_USERNAME: 'u', JNE_ORIGIN_CODE: 'BDO10000' };

  it('defaults to sandbox when JNE_ENVIRONMENT is absent', () => {
    expect(loadShippingConfig({ ...base } as NodeJS.ProcessEnv).jne.environment).toBe('sandbox');
  });

  it('never defaults to production', () => {
    for (const env of [{}, base, { ...base, JNE_BASE_URL: SANDBOX_URL }]) {
      expect(loadShippingConfig(env as NodeJS.ProcessEnv).jne.environment).not.toBe('production');
    }
  });

  it('keeps the existing sandbox base-URL default untouched', () => {
    expect(loadShippingConfig({ ...base } as NodeJS.ProcessEnv).jne.baseUrl).toBe('https://apiv2.jne.co.id:10102');
  });

  it('gives production NO default endpoint, so the guard fails instead of guessing', () => {
    const config = loadShippingConfig({ ...base, JNE_ENVIRONMENT: 'production' } as NodeJS.ProcessEnv);
    expect(config.jne.baseUrl).toBe('');
    expect(() => assertJneEnvironment(config.jne)).toThrow(/incomplete/);
  });

  it('carries an unrecognised value through to be rejected, not silently downgraded', () => {
    const config = loadShippingConfig({ ...base, JNE_ENVIRONMENT: 'prod' } as NodeJS.ProcessEnv);
    expect(config.jne.environment).toBe('prod');
    expect(() => assertJneEnvironment(config.jne)).toThrow(/must be "sandbox" or "production"/);
  });
});

describe('assertShippingConfigured applies the guard', () => {
  const shipping = (over: Partial<JneProviderConfig>): ShippingConfig =>
    ({
      originPostalCode: '40111',
      allowMockRates: false,
      paxel: { enabled: false, baseUrl: 'https://paxel.test', timeoutMs: 500, maxRetry: 0, needInsurance: false, defaultDimension: '30x35x20' },
      jne: jne(over),
      rajaongkir: { enabled: false, baseUrl: 'https://ro.test', timeoutMs: 500, maxRetry: 1 },
    }) as ShippingConfig;

  it('rejects a production courier on the sandbox endpoint', () => {
    expect(() => assertShippingConfigured(shipping({ environment: 'production', baseUrl: SANDBOX_URL }))).toThrow(
      /known sandbox endpoint/,
    );
  });

  it('still accepts the sandbox configuration', () => {
    expect(() => assertShippingConfigured(shipping({ environment: 'sandbox', baseUrl: SANDBOX_URL }))).not.toThrow();
  });
});

describe('validateEnv', () => {
  const VALID: Record<string, string> = {
    NODE_ENV: 'production',
    DATABASE_URL: 'mysql://u:p@db:3306/app',
    REDIS_URL: 'redis://redis:6379',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32),
    JWT_ADMIN_ACCESS_SECRET: 'c'.repeat(32),
    GOOGLE_CLIENT_ID: 'google-client-id',
    APP_URL: 'https://shop.example.com',
    CORS_ORIGINS: 'https://shop.example.com',
    CHECKOUT_IDEMPOTENCY_ENABLED: 'true',
    JNE_ENABLED: 'true',
    JNE_API_KEY: 'k',
    JNE_USERNAME: 'u',
    JNE_ORIGIN_CODE: 'BDO10000',
  };
  const valid = (over: Record<string, string | undefined> = {}) => ({ ...VALID, ...over });

  it('accepts an enabled sandbox courier on the sandbox endpoint', () => {
    expect(() => validateEnv(valid({ JNE_ENVIRONMENT: 'sandbox', JNE_BASE_URL: SANDBOX_URL }))).not.toThrow();
  });

  it('accepts an enabled courier with no JNE_ENVIRONMENT at all (means sandbox)', () => {
    expect(() => validateEnv(valid({ JNE_BASE_URL: SANDBOX_URL }))).not.toThrow();
  });

  it('rejects production on the sandbox endpoint', () => {
    expect(() => validateEnv(valid({ JNE_ENVIRONMENT: 'production', JNE_BASE_URL: SANDBOX_URL }))).toThrow(
      /JNE_BASE_URL/,
    );
  });

  it('rejects production with no base URL', () => {
    expect(() => validateEnv(valid({ JNE_ENVIRONMENT: 'production', JNE_BASE_URL: undefined }))).toThrow(/JNE_BASE_URL/);
  });

  it('rejects an unknown environment value', () => {
    expect(() => validateEnv(valid({ JNE_ENVIRONMENT: 'prod' }))).toThrow(/JNE_ENVIRONMENT/);
  });

  it('ignores the environment entirely when the courier is disabled', () => {
    expect(() => validateEnv(valid({ JNE_ENABLED: 'false', JNE_ENVIRONMENT: 'production', JNE_BASE_URL: undefined }))).not.toThrow();
  });
});

describe('tracking and cancel refuse to run against the sandbox in production', () => {
  /** Fails the test if the provider ever reaches the network. */
  const exploding = async () => {
    throw new Error('HTTP call attempted — the guard did not stop it');
  };

  const provider = (over: Partial<JneProviderConfig>) => {
    const p = new JneShipmentProvider({ jne: jne(over) } as ShippingConfig);
    (p as unknown as { http: unknown }).http = exploding;
    return p;
  };

  const misconfigured = { environment: 'production' as const, baseUrl: SANDBOX_URL };

  it('trackShipmentRaw refuses — the worker path that polls real cnotes', async () => {
    await expect(provider(misconfigured).trackShipmentRaw('CNOTE123')).rejects.toThrow(/known sandbox endpoint/);
  });

  it('trackShipment refuses', async () => {
    await expect(provider(misconfigured).trackShipment('CNOTE123')).rejects.toThrow(/known sandbox endpoint/);
  });

  it('cancelShipment refuses', async () => {
    await expect(provider(misconfigured).cancelShipment('CNOTE123')).rejects.toThrow(/known sandbox endpoint/);
  });

  it('refuses production with no endpoint configured at all', async () => {
    await expect(provider({ environment: 'production', baseUrl: '' }).trackShipmentRaw('CNOTE123')).rejects.toThrow(
      /incomplete/,
    );
  });

  it('still allows sandbox tracking — existing development is unaffected', async () => {
    const p = new JneShipmentProvider({ jne: jne({ environment: 'sandbox', baseUrl: SANDBOX_URL }) } as ShippingConfig);
    (p as unknown as { http: unknown }).http = async () => ({
      status: 200,
      text: async () => JSON.stringify({ cnote: { pod_status: 'DELIVERED' } }),
      headers: { get: () => null },
    });
    await expect(p.trackShipmentRaw('CNOTE123')).resolves.toBeDefined();
  });

  it('reports the misconfiguration without leaking credentials', async () => {
    const secret = 'super-secret-key';
    // Asserted by catching, not by an asymmetric matcher inside toThrow(): that
    // form can pass without ever comparing the message.
    let message = '';
    try {
      await provider({ ...misconfigured, apiKey: secret, username: secret }).trackShipmentRaw('CNOTE123');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/known sandbox endpoint/);
    expect(message).not.toContain(secret);
  });
});
