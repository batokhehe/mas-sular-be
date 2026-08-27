import { firstValueFrom, of, throwError } from 'rxjs';
import { AuditTrailInterceptor } from '../../src/infrastructure/audit/audit.interceptor';
import { ENTITY_DELEGATES, mapAuditRoute } from '../../src/infrastructure/audit/audit-route.map';

/**
 * PAXELBOX-34. PAXELBOX-33 reported that manual shipment mutation had no audit
 * sink. That was wrong: it searched for `auditLog.create` and missed the Audit
 * Trail, which is a separate, purpose-built system for exactly this.
 *
 * `PATCH /admin/shipments/:id` matches no explicit rule, so it lands on the
 * generic /admin mutation fallback — and because `Shipment` is a known entity
 * delegate, the interceptor snapshots the row BEFORE the handler runs. The
 * result is a record carrying the previous status, the new status, the acting
 * admin and the timestamp, without ShipmentHistory or a schema change.
 *
 * These pin that coverage, which is currently incidental: it comes from a
 * fallback plus a delegate-map entry, either of which could be changed without
 * anyone noticing this route stopped being audited.
 */

const SHIPMENT_ID = 'sh1';

function interceptor(before: Record<string, unknown> | null) {
  const recorded: Record<string, unknown>[] = [];
  const audit = { record: jest.fn((r: Record<string, unknown>) => void recorded.push(r)) };
  const prisma = { shipment: { findUnique: jest.fn().mockResolvedValue(before) } };
  return { it: new AuditTrailInterceptor(audit as never, prisma as never), recorded, prisma };
}

function request(over: Record<string, unknown> = {}) {
  return {
    method: 'PATCH',
    originalUrl: `/api/v1/admin/shipments/${SHIPMENT_ID}`,
    params: { id: SHIPMENT_ID },
    headers: { 'user-agent': 'jest' },
    ip: '10.0.0.1',
    body: { status: 'DELIVERED' },
    user: { sub: 'admin-uuid-1', name: 'Ops Admin' },
    ...over,
  };
}

function context(req: Record<string, unknown>) {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req }),
  } as never;
}

/** Drive one request through the interceptor and return what was recorded. */
async function run(
  before: Record<string, unknown> | null,
  after: unknown,
  req: Record<string, unknown> = request(),
) {
  const h = interceptor(before);
  await firstValueFrom(h.it.intercept(context(req), { handle: () => of(after) } as never));
  return h;
}

// ------------------------------------------------------- routing coverage

describe('the manual shipment edit is routed to the audit trail', () => {
  it('maps PATCH /admin/shipments/:id to a Shipment UPDATE', () => {
    expect(mapAuditRoute('PATCH', `/api/v1/admin/shipments/${SHIPMENT_ID}`)).toMatchObject({
      entity: 'Shipment',
      action: 'UPDATE',
    });
  });

  it('maps DELETE the same way', () => {
    expect(mapAuditRoute('DELETE', `/api/v1/admin/shipments/${SHIPMENT_ID}`)).toMatchObject({
      entity: 'Shipment',
      action: 'DELETE',
    });
  });

  it('knows how to read a Shipment, which is what makes a BEFORE snapshot possible', () => {
    expect(ENTITY_DELEGATES.Shipment).toBe('shipment');
  });
});

// ---------------------------------------------------- recorded content

describe('what the record actually contains', () => {
  it('captures the previous and the new status', async () => {
    const { recorded } = await run(
      { id: SHIPMENT_ID, status: 'CREATED', trackingNumber: 'AWB-1' },
      { id: SHIPMENT_ID, status: 'DELIVERED', trackingNumber: 'AWB-1' },
    );

    expect(recorded).toHaveLength(1);
    expect(recorded[0].before).toMatchObject({ status: 'CREATED' });
    expect(recorded[0].after).toMatchObject({ status: 'DELIVERED' });
  });

  it('snapshots BEFORE by reading the row, not by trusting the request body', async () => {
    const { prisma } = await run({ id: SHIPMENT_ID, status: 'CREATED' }, { id: SHIPMENT_ID, status: 'DELIVERED' });

    expect(prisma.shipment.findUnique).toHaveBeenCalledWith({ where: { id: SHIPMENT_ID } });
  });

  it('identifies the acting admin', async () => {
    const { recorded } = await run({ id: SHIPMENT_ID, status: 'CREATED' }, { id: SHIPMENT_ID, status: 'DELIVERED' });

    // admin.sub is Admin.id — the same identifier every other admin-authored
    // row in this schema stores.
    expect(recorded[0]).toMatchObject({
      adminId: 'admin-uuid-1',
      adminName: 'Ops Admin',
      entity: 'Shipment',
      entityId: SHIPMENT_ID,
      action: 'UPDATE',
      success: true,
    });
  });

  it('records the request context for traceability', async () => {
    const { recorded } = await run({ id: SHIPMENT_ID, status: 'CREATED' }, { id: SHIPMENT_ID, status: 'DELIVERED' });

    expect(recorded[0].ipAddress).toBe('10.0.0.1');
    expect(recorded[0].userAgent).toBe('jest');
  });

  it('records a REFUSED edit as an unsuccessful attempt', async () => {
    // The PAXELBOX-21/33 guards throw a ConflictException; a rejected attempt
    // is exactly the kind of thing an audit trail exists to keep.
    const h = interceptor({ id: SHIPMENT_ID, status: 'CREATED' });

    await expect(
      firstValueFrom(
        h.it.intercept(
          context(request()),
          { handle: () => throwError(() => new Error('Cannot change the provider')) } as never,
        ),
      ),
    ).rejects.toThrow('Cannot change the provider');

    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]).toMatchObject({ success: false, before: { status: 'CREATED' } });
  });
});

// -------------------------------------------------- provenance separation

describe('provider-driven history is a different record, by construction', () => {
  it('the audit trail only ever sees HTTP admin requests', async () => {
    // The tracking worker never passes through an interceptor, so it cannot
    // produce an AuditTrail row — and the admin edit writes no ShipmentHistory.
    // The two provenances are separated without a `source` column existing.
    const h = interceptor(null);
    const result = h.it.intercept(
      { getType: () => 'rpc', switchToHttp: () => ({ getRequest: () => ({}) }) } as never,
      { handle: () => of({ ok: true }) } as never,
    );

    await firstValueFrom(result);

    expect(h.recorded).toHaveLength(0);
  });

  it('an unauthenticated request records a null admin rather than inventing one', async () => {
    const { recorded } = await run(
      { id: SHIPMENT_ID, status: 'CREATED' },
      { id: SHIPMENT_ID, status: 'DELIVERED' },
      request({ user: undefined }),
    );

    expect(recorded[0].adminId).toBeNull();
    expect(recorded[0].adminName).toBeNull();
  });
});
