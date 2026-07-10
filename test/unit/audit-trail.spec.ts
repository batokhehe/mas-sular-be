import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { computeDiff, sanitizeSnapshot, deriveEntityName, prettyJson } from '../../src/infrastructure/audit/audit-diff.util';
import { mapAuditRoute, ENTITY_DELEGATES } from '../../src/infrastructure/audit/audit-route.map';
import { AuditTrailService } from '../../src/infrastructure/audit/audit-trail.service';
import { PermissionGuard } from '../../src/common/guards/permission.guard';

const tick = () => new Promise((r) => setImmediate(r));

describe('diff engine', () => {
  it('produces the spec example: price 25000→28000, stock 10→5', () => {
    const diff = computeDiff({ price: 25000, stock: 10 }, { price: 28000, stock: 5 });
    expect(diff).toEqual([
      { field: 'price', before: 25000, after: 28000 },
      { field: 'stock', before: 10, after: 5 },
    ]);
  });

  it('ignores timestamps (updatedAt/createdAt/lastLogin/*At) and sorts fields', () => {
    const diff = computeDiff(
      { z: 1, a: 1, updatedAt: '2026-01-01', createdAt: '2026-01-01', lastLogin: 'x', verifiedAt: 'y' },
      { z: 2, a: 2, updatedAt: '2026-02-02', createdAt: '2026-02-02', lastLogin: 'q', verifiedAt: 'w' },
    );
    expect(diff.map((d) => d.field)).toEqual(['a', 'z']); // sorted; no timestamp noise
  });

  it('CREATE/DELETE (one side missing) yields no field diff — snapshots carry the data', () => {
    expect(computeDiff(null, { price: 1 })).toEqual([]);
    expect(computeDiff({ price: 1 }, null)).toEqual([]);
  });

  it('sanitizeSnapshot strips secrets, sorts keys, serializes dates; prettyJson is stable', () => {
    const snap = sanitizeSnapshot({ b: 1, a: 2, passwordHash: 'x', token: 'y', at: new Date('2026-07-08T00:00:00Z') }) as Record<string, unknown>;
    expect(Object.keys(snap)).toEqual(['a', 'at', 'b']);
    expect(snap.passwordHash).toBeUndefined();
    expect(snap.at).toBe('2026-07-08T00:00:00.000Z');
    expect(prettyJson({ b: 1, a: 2 })).toBe('{\n  "a": 2,\n  "b": 1\n}');
  });

  it('deriveEntityName prefers name/title/orderNumber-style fields', () => {
    expect(deriveEntityName({ name: 'Bakso Urat' })).toBe('Bakso Urat');
    expect(deriveEntityName({ orderNumber: 'BMS-1' })).toBe('BMS-1');
    expect(deriveEntityName({ qty: 1 })).toBeNull();
  });
});

describe('recording — route mapping', () => {
  it('maps every named business action', () => {
    expect(mapAuditRoute('POST', '/api/v1/admin/auth/login')).toMatchObject({ action: 'LOGIN' });
    expect(mapAuditRoute('POST', '/api/v1/admin/auth/logout')).toMatchObject({ action: 'LOGOUT' });
    expect(mapAuditRoute('PATCH', '/api/v1/admin/payments/p1/verify')).toMatchObject({ action: 'VERIFY_PAYMENT', entity: 'Payment' });
    expect(mapAuditRoute('PATCH', '/api/v1/admin/payments/p1/reject')).toMatchObject({ action: 'REJECT_PAYMENT' });
    expect(mapAuditRoute('POST', '/api/v1/admin/orders/o1/shipment/retry')).toMatchObject({ action: 'SHIP_ORDER' });
    expect(mapAuditRoute('PATCH', '/api/v1/admin/orders/o1/status', { status: 'CANCELLED' })).toMatchObject({ action: 'CANCEL_ORDER' });
    expect(mapAuditRoute('PATCH', '/api/v1/admin/orders/o1/status', { status: 'PROCESSING' })).toMatchObject({ action: 'UPDATE' });
    expect(mapAuditRoute('POST', '/api/v1/admin/stock-transfers')).toMatchObject({ action: 'TRANSFER_STOCK' });
    expect(mapAuditRoute('PATCH', '/api/v1/admin/stock-transfers/t1/approve')).toMatchObject({ action: 'APPROVE' });
    expect(mapAuditRoute('PATCH', '/api/v1/admin/users/u1', { roleId: 'r1' })).toMatchObject({ action: 'ASSIGN_ROLE' });
    expect(mapAuditRoute('PATCH', '/api/v1/admin/users/u1', { roleId: null })).toMatchObject({ action: 'REMOVE_ROLE' });
    expect(mapAuditRoute('POST', '/api/v1/upload')).toMatchObject({ action: 'UPLOAD_IMAGE' });
    expect(mapAuditRoute('POST', '/api/v1/admin/system/notifications/n1/resend')).toMatchObject({ action: 'SEND_MANUAL_NOTIFICATION' });
  });

  it('generic fallback: CREATE/UPDATE/DELETE per method for any other admin mutation', () => {
    expect(mapAuditRoute('POST', '/api/v1/admin/catalog/products')).toMatchObject({ module: 'products', entity: 'Product', action: 'CREATE' });
    expect(mapAuditRoute('PATCH', '/api/v1/admin/catalog/products/p1')).toMatchObject({ action: 'UPDATE' });
    expect(mapAuditRoute('DELETE', '/api/v1/admin/catalog/categories/c1')).toMatchObject({ entity: 'Category', action: 'DELETE' });
  });

  it('never audits reads, storefront routes, or the audit endpoints themselves', () => {
    expect(mapAuditRoute('GET', '/api/v1/admin/orders')).toBeNull();
    expect(mapAuditRoute('POST', '/api/v1/checkout/order')).toBeNull();
    expect(mapAuditRoute('POST', '/api/v1/admin/system/audit/export')).toBeNull();
  });

  it('delegate registry covers the mutable entities (before-state snapshots)', () => {
    for (const e of ['Product', 'Order', 'Payment', 'Role', 'Outlet', 'StockTransfer']) expect(ENTITY_DELEGATES[e]).toBeTruthy();
  });
});

describe('AuditTrailService', () => {
  function build() {
    const prisma = {
      auditTrail: {
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([{ id: 'a1', diff: [{ field: 'price' }], createdAt: new Date(), adminName: 'Ops', module: 'products', entity: 'Product', entityId: 'p1', entityName: 'Bakso', action: 'UPDATE', success: true, requestId: null, ipAddress: null }]),
        count: jest.fn().mockResolvedValue(7),
        findUnique: jest.fn().mockResolvedValue({ id: 'a1', entity: 'Product', entityId: 'p1', createdAt: new Date('2026-07-08T10:00:00Z') }),
        findFirst: jest.fn().mockResolvedValue({ id: 'prev' }),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ total: 12, ok: 10, failed: 2, admins: 3 }]),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { service: new AuditTrailService(prisma as any), prisma };
  }

  it('recording: persists sanitized snapshots + computed diff, fire-and-forget', async () => {
    const { service, prisma } = build();
    service.record({
      adminId: 'adm-1', adminName: 'Ops', module: 'products', entity: 'Product', entityId: 'p1', action: 'UPDATE',
      before: { price: 25000, stock: 10, passwordHash: 'x', updatedAt: new Date() },
      after: { price: 28000, stock: 5, updatedAt: new Date() },
      success: true,
    });
    await tick();
    const data = prisma.auditTrail.create.mock.calls[0][0].data;
    expect(data.diff).toEqual([
      { field: 'price', before: 25000, after: 28000 },
      { field: 'stock', before: 10, after: 5 },
    ]);
    expect(JSON.stringify(data.before)).not.toContain('passwordHash');
    expect(data.entityName).toBeNull(); // no name-like field present
  });

  it('recording failures never throw', async () => {
    const { service, prisma } = build();
    prisma.auditTrail.create.mockRejectedValue(new Error('db down'));
    expect(() => service.record({ module: 'm', entity: 'E', action: 'CREATE', success: true })).not.toThrow();
    await tick();
  });

  it('filtering: where clause covers module/action/admin/entity/success/date/search', () => {
    const { service } = build();
    const from = new Date('2026-07-01'); const to = new Date('2026-07-08');
    const where = service.buildWhere({ module: 'payments', action: 'VERIFY_PAYMENT', admin: 'ops', entity: 'Payment', success: false, search: 'BMS-1', dateFrom: from, dateTo: to });
    expect(where).toMatchObject({
      module: 'payments', action: 'VERIFY_PAYMENT', entity: 'Payment', success: false,
      OR: [{ adminId: 'ops' }, { adminName: { contains: 'ops' } }],
      createdAt: { gte: from, lte: to },
    });
    expect((where.AND as unknown[])[0]).toMatchObject({ OR: expect.arrayContaining([{ entityId: 'BMS-1' }, { entityName: { contains: 'BMS-1' } }]) });
  });

  it('list: paginated newest-first + summary cards (today/success/failed/unique admins)', async () => {
    const { service, prisma } = build();
    const res = await service.list({ page: 1, limit: 20 });
    expect(prisma.auditTrail.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: { createdAt: 'desc' }, skip: 0, take: 20 }));
    expect(res.summary).toEqual({ todayChanges: 12, successful: 10, failed: 2, uniqueAdmins: 3 });
    expect(res).toEqual(expect.objectContaining({ total: 7 }));
  });

  it('timeline: detail returns previous/next/timeline for the same entity; 404 when missing', async () => {
    const { service, prisma } = build();
    const d = await service.detail('a1');
    expect(prisma.auditTrail.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ entity: 'Product', entityId: 'p1' }) }));
    expect(d.previous).toEqual({ id: 'prev' });
    expect(Array.isArray(d.timeline)).toBe(true);
    prisma.auditTrail.findUnique.mockResolvedValueOnce(null);
    await expect(service.detail('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('export: streams CSV header + escaped rows in batches and ends the response', async () => {
    const { service, prisma } = build();
    prisma.auditTrail.findMany
      .mockResolvedValueOnce([{ id: 'a1', createdAt: new Date('2026-07-08T10:00:00Z'), adminName: 'Ops, Admin', adminId: 'adm-1', module: 'products', entity: 'Product', entityId: 'p1', entityName: 'Bakso "Urat"', action: 'UPDATE', success: true, diff: [{ f: 1 }], requestId: 'req-1', ipAddress: '1.2.3.4' }])
      .mockResolvedValueOnce([]);
    const chunks: string[] = [];
    const res = { setHeader: jest.fn(), write: jest.fn((s: string) => chunks.push(s)), end: jest.fn() };
    await service.exportCsv({}, res as never);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv; charset=utf-8');
    expect(chunks[0]).toContain('id,createdAt,admin,module');
    expect(chunks[1]).toContain('"Ops, Admin"'); // comma escaped
    expect(chunks[1]).toContain('"Bakso ""Urat"""'); // quote escaped
    expect(res.end).toHaveBeenCalled();
  });

  // --- Regression: ML-2 — a cancelled download stops the export immediately. ---
  it('export: a client gone BEFORE the loop performs zero database reads', async () => {
    const { service, prisma } = build();
    const res = { setHeader: jest.fn(), write: jest.fn(), end: jest.fn(), writableEnded: true };
    await expect(service.exportCsv({}, res as never)).resolves.toBeUndefined(); // never throws
    expect(prisma.auditTrail.findMany).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled(); // nothing to end — socket is gone
  });

  it('export: an abort mid-batch stops row generation and further batches', async () => {
    const { service, prisma } = build();
    const row = (i: number) => ({ id: `a${i}`, createdAt: new Date(), adminName: 'A', adminId: 'x', module: 'm', entity: 'E', entityId: 'e', entityName: 'n', action: 'UPDATE', success: true, diff: [], requestId: 'r', ipAddress: 'ip' });
    // A FULL batch (EXPORT_BATCH = 1000) — without the abort the loop would fetch a second batch.
    prisma.auditTrail.findMany.mockResolvedValue(Array.from({ length: 1000 }, (_, i) => row(i)));
    let closeCb: (() => void) | undefined;
    let writes = 0;
    const res = {
      setHeader: jest.fn(),
      end: jest.fn(),
      req: { on: (evt: string, cb: () => void) => { if (evt === 'close') closeCb = cb; } },
      write: jest.fn(() => {
        writes += 1;
        if (writes === 5) closeCb?.(); // browser cancels mid-batch
      }),
    };
    await expect(service.exportCsv({}, res as never)).resolves.toBeUndefined();
    expect(prisma.auditTrail.findMany).toHaveBeenCalledTimes(1); // no second batch read
    expect(writes).toBeLessThan(20); // stopped right after the abort, not after 200 rows
    expect(res.end).not.toHaveBeenCalled();
  });
});

describe('Audit permissions', () => {
  function guard(perm: string, user: { permissions?: string[] }) {
    const reflector = { getAllAndOverride: () => [perm] };
    const g = new PermissionGuard(reflector as never);
    const ctx = { switchToHttp: () => ({ getRequest: () => ({ user }) }), getHandler: () => null, getClass: () => null } as never;
    return () => g.canActivate(ctx);
  }
  it('Audit.read gates viewing; Audit.export gates CSV; SUPER_ADMIN bypasses', () => {
    expect(guard('Audit.read', { permissions: ['Audit.read'] })()).toBe(true);
    expect(guard('Audit.read', { permissions: ['SystemLog.read'] })).toThrow(ForbiddenException);
    expect(guard('Audit.export', { permissions: ['Audit.read'] })).toThrow(ForbiddenException);
    expect(guard('Audit.export', { permissions: ['Audit.export'] })()).toBe(true);
    const superAdmin = { role: 'SUPER_ADMIN', permissions: [] as string[] };
    const reflector = { getAllAndOverride: () => ['Audit.export'] };
    const g = new PermissionGuard(reflector as never);
    const ctx = { switchToHttp: () => ({ getRequest: () => ({ user: superAdmin }) }), getHandler: () => null, getClass: () => null } as never;
    expect(g.canActivate(ctx)).toBe(true);
  });
});
