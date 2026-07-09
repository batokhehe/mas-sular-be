import { acceptableRequestId, redactSensitivePath, redactSensitiveQuery } from '../../src/common/logging/redact';

describe('redactSensitiveQuery (persisted request metadata)', () => {
  it('redacts credential-bearing query values but keeps the keys visible', () => {
    expect(
      redactSensitiveQuery({
        token: 'eyJhbGciOiJIUzI1NiJ9.payload.sig', // SSE stream JWT
        access_token: 'abc',
        apiKey: 'k',
        api_key: 'k2',
        client_secret: 'x',
        password: 'hunter2',
        authorization: 'Bearer x',
      }),
    ).toEqual({
      token: '[REDACTED]',
      access_token: '[REDACTED]',
      apiKey: '[REDACTED]',
      api_key: '[REDACTED]',
      client_secret: '[REDACTED]',
      password: '[REDACTED]',
      authorization: '[REDACTED]',
    });
  });

  it('leaves ordinary filter params untouched', () => {
    const query = { page: '2', status: 'FAILED', search: 'BMS-1', unread: 'true' };
    expect(redactSensitiveQuery(query)).toEqual(query);
  });

  it('passes non-object inputs through unchanged', () => {
    expect(redactSensitiveQuery(undefined)).toBeUndefined();
    expect(redactSensitiveQuery(null)).toBeNull();
    expect(redactSensitiveQuery('raw')).toBe('raw');
    expect(redactSensitiveQuery(['a'])).toEqual(['a']);
  });
});

describe('acceptableRequestId (inbound X-Request-Id)', () => {
  it('accepts UUID-like safe correlation tokens', () => {
    expect(acceptableRequestId('550e8400-e29b-41d4-a716-446655440000')).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(acceptableRequestId('req_abc123.DEF')).toBe('req_abc123.DEF');
  });

  it('rejects short, oversized, injection-shaped, and non-string values', () => {
    expect(acceptableRequestId('short')).toBeNull(); // < 8 chars
    expect(acceptableRequestId('x'.repeat(65))).toBeNull(); // > 64 chars
    expect(acceptableRequestId('abc def\ninjected=true')).toBeNull(); // whitespace/newline
    expect(acceptableRequestId('<script>alert(1)</script>')).toBeNull();
    expect(acceptableRequestId(undefined)).toBeNull();
    expect(acceptableRequestId(['a-b-c-d-e-f'])).toBeNull();
  });
});

describe('redactSensitivePath (regression: existing behavior kept)', () => {
  it('still redacts the payment-upload token segment only', () => {
    expect(redactSensitivePath('/api/v1/payments/upload/tok-123?x=1')).toBe('/api/v1/payments/upload/[REDACTED]?x=1');
    expect(redactSensitivePath('/api/v1/orders/o-1')).toBe('/api/v1/orders/o-1');
  });
});
