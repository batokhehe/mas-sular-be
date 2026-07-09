import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { from, Observable, throwError } from 'rxjs';
import { catchError, switchMap, tap } from 'rxjs/operators';
import type { Request } from 'express';
import { PrismaService } from '../../database/prisma.service';
import { getRequestId } from '../logging/request-context';
import { AuditRouteMatch, ENTITY_DELEGATES, mapAuditRoute } from './audit-route.map';
import { AuditTrailService } from './audit-trail.service';

interface AdminReqUser {
  sub?: string;
  name?: string;
}

/**
 * Global interceptor that AUTOMATICALLY records admin mutations to the Audit
 * Trail. Fully additive: business handlers are untouched — the interceptor maps
 * the route to an action, snapshots the BEFORE state (for known entities), lets
 * the handler run, then records after/diff fire-and-forget. Guards run first, so
 * the admin identity is available; failures are recorded with success=false.
 */
@Injectable()
export class AuditTrailInterceptor implements NestInterceptor {
  constructor(
    private readonly audit: AuditTrailService,
    private readonly prisma: PrismaService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<Request & { user?: AdminReqUser }>();
    const path = (req.originalUrl ?? req.url ?? '').split('?')[0];
    const mapped = mapAuditRoute(req.method, path, req.body as Record<string, unknown> | undefined);
    if (!mapped) return next.handle();

    const entityId = this.entityIdOf(req);
    const base = this.baseRecord(req, mapped, entityId);

    // BEFORE must be captured before the handler mutates the row.
    return from(this.captureBefore(mapped, entityId)).pipe(
      switchMap((before) =>
        next.handle().pipe(
          tap((response) => {
            this.audit.record({ ...base, before, after: this.snapshotOf(response), success: true });
          }),
          catchError((err) => {
            this.audit.record({
              ...base,
              before,
              success: false,
              metadata: { ...base.metadata, error: err instanceof Error ? err.message : String(err) },
            });
            return throwError(() => err);
          }),
        ),
      ),
    );
  }

  private baseRecord(req: Request & { user?: AdminReqUser }, mapped: AuditRouteMatch, entityId: string | null) {
    const fwd = req.headers['x-forwarded-for'];
    const ip = typeof fwd === 'string' && fwd.length ? fwd.split(',')[0].trim() : (req.ip ?? null);
    // LOGIN happens pre-auth → identify by the submitted email (password is never kept).
    const loginEmail = mapped.action === 'LOGIN' ? (req.body as { email?: string } | undefined)?.email : undefined;
    return {
      adminId: req.user?.sub ?? null,
      adminName: req.user?.name ?? loginEmail ?? null,
      ipAddress: ip,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      requestId: getRequestId() ?? null,
      module: mapped.module,
      entity: mapped.entity,
      entityId,
      action: mapped.action,
      metadata: { method: req.method, path: (req.originalUrl ?? '').split('?')[0] } as Record<string, unknown>,
    };
  }

  private entityIdOf(req: Request): string | null {
    const params = (req.params ?? {}) as Record<string, string | undefined>;
    const candidate = params.id ?? params.paymentId ?? params.orderId ?? params.requestId ?? Object.values(params)[0];
    return candidate ?? null;
  }

  /** Pre-mutation snapshot for known entities (UPDATE/DELETE-style actions only). */
  private async captureBefore(mapped: AuditRouteMatch, entityId: string | null): Promise<unknown> {
    if (!entityId || mapped.action === 'CREATE' || mapped.action === 'LOGIN' || mapped.action === 'LOGOUT') return null;
    const delegate = ENTITY_DELEGATES[mapped.entity];
    if (!delegate) return null;
    try {
      const model = (this.prisma as unknown as Record<string, { findUnique?: (args: unknown) => Promise<unknown> }>)[delegate];
      return (await model?.findUnique?.({ where: { id: entityId } })) ?? null;
    } catch {
      return null; // never block the request on audit pre-fetch
    }
  }

  /** Only object responses are stored (arrays/streams/scalars are not snapshots). */
  private snapshotOf(response: unknown): unknown {
    if (!response || typeof response !== 'object' || Array.isArray(response)) return null;
    return response;
  }
}
