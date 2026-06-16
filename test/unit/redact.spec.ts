import { redactSensitivePath } from '../../src/common/logging/redact';

describe('redactSensitivePath', () => {
  it('redacts the upload token segment', () => {
    expect(redactSensitivePath('/payments/upload/abc123deadbeef')).toBe('/payments/upload/[REDACTED]');
  });

  it('redacts under the global api/version prefix', () => {
    expect(redactSensitivePath('/api/v1/payments/upload/abc123')).toBe('/api/v1/payments/upload/[REDACTED]');
  });

  it('preserves a trailing query string while redacting the token', () => {
    expect(redactSensitivePath('/payments/upload/secrettoken?foo=bar')).toBe('/payments/upload/[REDACTED]?foo=bar');
  });

  it('leaves unrelated paths unchanged', () => {
    expect(redactSensitivePath('/api/v1/orders/checkout')).toBe('/api/v1/orders/checkout');
    expect(redactSensitivePath('/payments/pay-1/manual-receipt')).toBe('/payments/pay-1/manual-receipt');
  });

  it('passes through undefined', () => {
    expect(redactSensitivePath(undefined)).toBeUndefined();
  });
});
