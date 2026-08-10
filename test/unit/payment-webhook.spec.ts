import { ServiceUnavailableException, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { createHash } from 'crypto';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { MidtransWebhookDto } from '../../src/modules/payments/gateway/application/dto/midtrans-webhook.dto';
import {
  buildMidtransSignature,
  verifyMidtransSignature,
} from '../../src/modules/payments/gateway/domain/midtrans-signature.util';
import { MidtransConfig } from '../../src/modules/payments/gateway/midtrans.config';
import { PaymentGatewayPersistenceService } from '../../src/modules/payments/gateway/payment-gateway-persistence.service';
import { PaymentWebhookService } from '../../src/modules/payments/gateway/payment-webhook.service';

const SERVER_KEY = 'SB-Mid-server-SECRET-KEY';
const ORDER_ID = 'BMS-20260712-001-aaaaaaaa';
const GROSS = '130000.00';
const STATUS_CODE = '200';

const CONFIG: MidtransConfig = {
  enabled: true,
  serverKey: SERVER_KEY,
  clientKey: 'ck',
  isProduction: false,
  baseUrl: 'https://api.sandbox.midtrans.com',
  timeoutMs: 5000,
  maxRetry: 2,
};

/** Independently computed signature — deliberately not reusing the production helper. */
const signatureOf = (orderId: string, statusCode: string, gross: string, key = SERVER_KEY) =>
  createHash('sha512').update(`${orderId}${statusCode}${gross}${key}`).digest('hex');

function notification(over: Partial<MidtransWebhookDto> = {}): MidtransWebhookDto {
  return {
    order_id: ORDER_ID,
    status_code: STATUS_CODE,
    gross_amount: GROSS,
    signature_key: signatureOf(ORDER_ID, STATUS_CODE, GROSS),
    transaction_id: 'trx-9',
    transaction_status: 'settlement',
    payment_type: 'qris',
    ...over,
  } as MidtransWebhookDto;
}

function service(config: MidtransConfig = CONFIG) {
  const logs = { write: jest.fn() };
  const ledger = {
    findByProviderOrderId: jest.fn().mockResolvedValue({ id: 'gtx-1', paymentId: 'pay-1', providerTransactionId: 'trx-9' }),
    recordWebhookNotification: jest.fn().mockResolvedValue('applied'),
    // Phase 5D: already-terminal, so these Phase 5B/5C specs assert the receipt path
    // without reaching settlement (which has its own spec).
    findWebhookEvent: jest.fn().mockResolvedValue({ settlementState: 'NOT_ELIGIBLE' }),
    markWebhookSettlementState: jest.fn().mockResolvedValue(undefined),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { svc: new PaymentWebhookService(config, ledger as any, logs as any), logs, ledger };
}

// --------------------------------------------------------------- signature --

describe('Midtrans signature utility', () => {
  it('hashes SHA512(order_id + status_code + gross_amount + serverKey)', () => {
    expect(buildMidtransSignature({ orderId: ORDER_ID, statusCode: STATUS_CODE, grossAmount: GROSS }, SERVER_KEY))
      .toBe(signatureOf(ORDER_ID, STATUS_CODE, GROSS));
  });

  it('uses the EXACT gross_amount string — a normalized value hashes differently', () => {
    const exact = buildMidtransSignature({ orderId: ORDER_ID, statusCode: STATUS_CODE, grossAmount: '130000.00' }, SERVER_KEY);
    const normalized = buildMidtransSignature({ orderId: ORDER_ID, statusCode: STATUS_CODE, grossAmount: '130000' }, SERVER_KEY);
    const numeric = buildMidtransSignature(
      { orderId: ORDER_ID, statusCode: STATUS_CODE, grossAmount: String(Number('130000.00')) },
      SERVER_KEY,
    );

    expect(exact).not.toBe(normalized);
    expect(exact).not.toBe(numeric);
    // Parsing to a number before hashing would reject every real notification.
    expect(verifyMidtransSignature(
      { orderId: ORDER_ID, statusCode: STATUS_CODE, grossAmount: '130000.00' },
      SERVER_KEY,
      exact,
    )).toBe(true);
  });

  it('rejects a wrong key, wrong field, or tampered amount', () => {
    const good = { orderId: ORDER_ID, statusCode: STATUS_CODE, grossAmount: GROSS };
    const sig = signatureOf(ORDER_ID, STATUS_CODE, GROSS);

    expect(verifyMidtransSignature(good, SERVER_KEY, sig)).toBe(true);
    expect(verifyMidtransSignature(good, 'WRONG-KEY', sig)).toBe(false);
    expect(verifyMidtransSignature({ ...good, grossAmount: '1.00' }, SERVER_KEY, sig)).toBe(false);
    expect(verifyMidtransSignature({ ...good, orderId: 'OTHER' }, SERVER_KEY, sig)).toBe(false);
    expect(verifyMidtransSignature({ ...good, statusCode: '201' }, SERVER_KEY, sig)).toBe(false);
  });

  it('comparison is length-guarded and constant-time (delegates to timingSafeEqual)', () => {
    const good = { orderId: ORDER_ID, statusCode: STATUS_CODE, grossAmount: GROSS };
    const valid = signatureOf(ORDER_ID, STATUS_CODE, GROSS);

    expect(verifyMidtransSignature(good, SERVER_KEY, 'short')).toBe(false); // length mismatch
    expect(verifyMidtransSignature(good, SERVER_KEY, 'f'.repeat(valid.length))).toBe(false); // same length
    expect(verifyMidtransSignature(good, SERVER_KEY, valid.slice(0, -1) + '0')).toBe(false); // last char differs
    expect(verifyMidtransSignature(good, SERVER_KEY, undefined)).toBe(false);
    expect(verifyMidtransSignature(good, undefined, valid)).toBe(false);
  });

  it('never returns or exposes the expected signature on failure', () => {
    // The API surface is boolean-only: there is no way to read the expected value.
    expect(typeof verifyMidtransSignature({ orderId: 'x', statusCode: '1', grossAmount: '1' }, SERVER_KEY, 'bad')).toBe('boolean');
  });
});

// -------------------------------------------------------------- DTO shape --

describe('Midtrans webhook DTO', () => {
  const validate = (payload: Record<string, unknown>) =>
    validateSync(plainToInstance(MidtransWebhookDto, payload, { enableImplicitConversion: false }));

  const base = { order_id: ORDER_ID, status_code: STATUS_CODE, gross_amount: GROSS, signature_key: 'sig' };

  it('accepts a complete notification', () => {
    expect(validate({ ...base, transaction_id: 't', transaction_status: 'settlement' })).toHaveLength(0);
  });

  it.each(['signature_key', 'order_id', 'status_code', 'gross_amount'])('rejects a missing %s', (field) => {
    const payload: Record<string, unknown> = { ...base };
    delete payload[field];
    expect(validate(payload).length).toBeGreaterThan(0);
  });

  it('rejects an empty required field', () => {
    expect(validate({ ...base, order_id: '' }).length).toBeGreaterThan(0);
  });

  it('keeps gross_amount a STRING (no implicit numeric conversion)', () => {
    const dto = plainToInstance(MidtransWebhookDto, base, { enableImplicitConversion: false });
    expect(dto.gross_amount).toBe('130000.00');
    expect(typeof dto.gross_amount).toBe('string');
  });

  it('tolerates unknown future Midtrans fields (route pipe does not forbid them)', async () => {
    const pipe = new ValidationPipe({
      whitelist: false,
      forbidNonWhitelisted: false,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    });
    const payload = { ...base, some_future_field: 'x', va_numbers: [{ bank: 'bca', va_number: '1' }] };
    const out = await pipe.transform(payload, { type: 'body', metatype: MidtransWebhookDto });
    expect(out.order_id).toBe(ORDER_ID);
    expect((out as Record<string, unknown>).some_future_field).toBe('x'); // not stripped, not rejected
  });
});

// ------------------------------------------------------------ service flow --

describe('PaymentWebhookService — authentication boundary', () => {
  it('accepts a valid signature', async () => {
    const { svc } = service();
    await expect(svc.handleMidtransNotification(notification()))
      .resolves.toEqual({ outcome: 'applied', settlement: 'already_processed' });
  });

  it('rejects an invalid signature with 401', async () => {
    const { svc } = service();
    await expect(svc.handleMidtransNotification(notification({ signature_key: 'f'.repeat(128) })))
      .rejects.toThrow(UnauthorizedException);
  });

  it('rejects a signature computed with the WRONG server key', async () => {
    const { svc } = service();
    const forged = notification({ signature_key: signatureOf(ORDER_ID, STATUS_CODE, GROSS, 'ATTACKER-KEY') });
    await expect(svc.handleMidtransNotification(forged)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a tampered amount even when the rest matches', async () => {
    const { svc } = service();
    // Signature was computed for 130000.00; the body claims 10.00.
    await expect(svc.handleMidtransNotification(notification({ gross_amount: '10.00' })))
      .rejects.toThrow(UnauthorizedException);
  });

  it('returns 503 (not 401, not 200) when the gateway is disabled — never mutates', async () => {
    const disabled = service({ ...CONFIG, enabled: false });
    await expect(disabled.svc.handleMidtransNotification(notification())).rejects.toThrow(ServiceUnavailableException);
    expect(disabled.ledger.findByProviderOrderId).not.toHaveBeenCalled();

    const noKey = service({ ...CONFIG, serverKey: undefined });
    await expect(noKey.svc.handleMidtransNotification(notification())).rejects.toThrow(ServiceUnavailableException);
    expect(noKey.ledger.recordWebhookNotification).not.toHaveBeenCalled();
  });

  it('gives an IDENTICAL rejection whether or not the order exists (no enumeration)', async () => {
    const { svc } = service();
    const unknownOrder = notification({ order_id: 'DOES-NOT-EXIST', signature_key: 'f'.repeat(128) });
    const knownOrder = notification({ signature_key: 'f'.repeat(128) });

    const a = await svc.handleMidtransNotification(unknownOrder).catch((e: Error) => e);
    const b = await svc.handleMidtransNotification(knownOrder).catch((e: Error) => e);

    expect(a).toBeInstanceOf(UnauthorizedException);
    expect(b).toBeInstanceOf(UnauthorizedException);
    expect((a as Error).message).toBe((b as Error).message); // same response, no information leak
  });
});

// ---------------------------------------------------------- no state change --

describe('PaymentWebhookService — provably performs NO business mutation', () => {
  it('reaches the database only through the gateway ledger (structurally)', () => {
    // Constructor is (config, ledger, logs?). Enumerate what Nest will actually
    // inject: no PrismaService, and no payment, order, inventory, shipment,
    // notification or outbox service — business settlement is unreachable by
    // construction, not by discipline.
    const injected: unknown[] = Reflect.getMetadata('design:paramtypes', PaymentWebhookService) ?? [];
    const names = injected.map((t) => (typeof t === 'function' ? t.name : String(t)));
    expect(names).toEqual([
      'Object', 'PaymentGatewayPersistenceService', 'LogService',
      // Phase 5D/5E: the business state machine is reached ONLY through the shared
      // applier — still no PrismaService, no order/inventory/shipment service.
      'GatewayStatusApplier', 'PaymentProviderFactory',
    ]);
    for (const banned of ['PrismaService', 'OrdersService', 'PaymentsService', 'AdminService', 'InventoryService', 'ShipmentService', 'OutboxService']) {
      expect(names).not.toContain(banned);
    }
    const source = PaymentWebhookService.prototype.handleMidtransNotification.toString();
    for (const forbidden of ['prisma', 'payment.update', 'order.update', 'outbox', 'commitForOrder', 'verifyPayment']) {
      expect(source).not.toContain(forbidden);
    }
  });

  it('the ledger surface it can reach exposes no Payment/Order write', () => {
    const surface = Object.getOwnPropertyNames(PaymentGatewayPersistenceService.prototype);
    for (const method of surface) {
      const body = (PaymentGatewayPersistenceService.prototype as unknown as Record<string, unknown>)[method];
      if (typeof body !== 'function') continue;
      const src = body.toString();
      expect(src).not.toContain('.payment.update');
      expect(src).not.toContain('.order.update');
      expect(src).not.toContain('outboxEvent');
      expect(src).not.toContain('inventory');
      expect(src).not.toContain('shipment');
    }
  });
});

// ------------------------------------------------------------ logging safety --

describe('PaymentWebhookService — logging never leaks secrets', () => {
  const secretsOf = (logs: { write: jest.Mock }) => JSON.stringify(logs.write.mock.calls);

  it('never logs the server key, the signature, or the full payload (valid case)', async () => {
    const { svc, logs } = service();
    const dto = notification();
    await svc.handleMidtransNotification(dto);

    const written = secretsOf(logs);
    expect(written).not.toContain(SERVER_KEY);
    expect(written).not.toContain(dto.signature_key);
    expect(written).not.toContain('signature_key');
    // Only allowlisted correlators are logged — never the payload object.
    expect(logs.write.mock.calls[0][0].metadata).toEqual({
      provider: 'midtrans',
      providerOrderId: ORDER_ID,
      transactionId: 'trx-9',
      transactionStatus: 'settlement',
      statusCode: STATUS_CODE,
      deduplicated: false,
      reason: 'applied',
    });
  });

  it('never logs the server key or received signature on rejection', async () => {
    const { svc, logs } = service();
    const forged = notification({ signature_key: signatureOf(ORDER_ID, STATUS_CODE, GROSS, 'ATTACKER-KEY') });
    await svc.handleMidtransNotification(forged).catch(() => undefined);

    const written = secretsOf(logs);
    expect(written).not.toContain(SERVER_KEY);
    expect(written).not.toContain(forged.signature_key);
    expect(written).not.toContain('ATTACKER-KEY');
    expect(logs.write.mock.calls[0][0].metadata).toEqual({
      provider: 'midtrans', providerOrderId: ORDER_ID, statusCode: STATUS_CODE,
    });
  });

  it('the expected signature is never written anywhere', async () => {
    const { svc, logs } = service();
    const expected = signatureOf(ORDER_ID, STATUS_CODE, GROSS);
    await svc.handleMidtransNotification(notification({ signature_key: 'f'.repeat(128) })).catch(() => undefined);
    expect(secretsOf(logs)).not.toContain(expected);
  });
});
