import { loadIdempotencyConfig } from '../../src/infrastructure/idempotency/idempotency.config';

describe('loadIdempotencyConfig', () => {
  it('defaults both checkout flags to false', () => {
    const cfg = loadIdempotencyConfig({});
    expect(cfg.checkoutEnabled).toBe(false);
    expect(cfg.checkoutRequired).toBe(false);
  });

  it('parses enabled and required from env', () => {
    const cfg = loadIdempotencyConfig({
      CHECKOUT_IDEMPOTENCY_ENABLED: 'true',
      CHECKOUT_IDEMPOTENCY_REQUIRED: 'true',
    });
    expect(cfg.checkoutEnabled).toBe(true);
    expect(cfg.checkoutRequired).toBe(true);
  });

  it('allows required=false with enabled=false', () => {
    expect(() => loadIdempotencyConfig({ CHECKOUT_IDEMPOTENCY_ENABLED: 'false' })).not.toThrow();
  });

  it('fails startup when REQUIRED=true but ENABLED=false', () => {
    expect(() =>
      loadIdempotencyConfig({
        CHECKOUT_IDEMPOTENCY_REQUIRED: 'true',
        CHECKOUT_IDEMPOTENCY_ENABLED: 'false',
      }),
    ).toThrow(/REQUIRED=true requires CHECKOUT_IDEMPOTENCY_ENABLED=true/);
  });

  it('fails startup when REQUIRED=true and ENABLED is unset', () => {
    expect(() => loadIdempotencyConfig({ CHECKOUT_IDEMPOTENCY_REQUIRED: 'true' })).toThrow();
  });
});
