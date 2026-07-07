import { Inject, Injectable } from '@nestjs/common';
import { LogLevel, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { LOG_CONFIG, LogConfig } from './log.config';
import { getRequestContext } from './request-context';

export interface LogEntry {
  level?: LogLevel;
  module: string;
  action: string;
  message: string;
  requestId?: string | null;
  userId?: string | null;
  adminId?: string | null;
  orderId?: string | null;
  paymentId?: string | null;
  shipmentId?: string | null;
  inventoryReservationId?: string | null;
  ip?: string | null;
  method?: string | null;
  path?: string | null;
  statusCode?: number | null;
  durationMs?: number | null;
  metadata?: Record<string, unknown> | null;
}

const MESSAGE_MAX = 8000;

/**
 * Persists structured logs into `SystemLog`. ADDITIVE — it never replaces the Pino
 * logger; callers keep logging as before and may ALSO call `write()` for a durable,
 * queryable record. Writes are fire-and-forget and swallow all errors so logging can
 * never break a request, a worker, or business logic. `requestId`/`userId`/`adminId`
 * are auto-filled from the AsyncLocalStorage request context when not supplied.
 */
@Injectable()
export class LogService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(LOG_CONFIG) private readonly config: LogConfig,
  ) {}

  /** Fire-and-forget structured log. Never throws. */
  write(entry: LogEntry): void {
    if (!this.config.enabled) return;
    void this.persist(entry).catch(() => undefined);
  }

  private async persist(entry: LogEntry): Promise<void> {
    const ctx = getRequestContext();
    await this.prisma.systemLog.create({
      data: {
        level: entry.level ?? LogLevel.INFO,
        module: entry.module.slice(0, 64),
        action: entry.action.slice(0, 96),
        message: (entry.message ?? '').slice(0, MESSAGE_MAX),
        requestId: entry.requestId ?? ctx?.requestId ?? null,
        userId: entry.userId ?? ctx?.userId ?? null,
        adminId: entry.adminId ?? ctx?.adminId ?? null,
        orderId: entry.orderId ?? null,
        paymentId: entry.paymentId ?? null,
        shipmentId: entry.shipmentId ?? null,
        inventoryReservationId: entry.inventoryReservationId ?? null,
        ip: entry.ip ?? ctx?.ip ?? null,
        method: entry.method ?? ctx?.method ?? null,
        path: (entry.path ?? ctx?.path ?? null)?.slice(0, 512) ?? null,
        statusCode: entry.statusCode ?? null,
        durationMs: entry.durationMs ?? null,
        metadata: this.sanitize(entry.metadata),
      },
    });
  }

  /** Strip undefined/circular/functions so the JSON column always accepts the value. */
  private sanitize(metadata: Record<string, unknown> | null | undefined): Prisma.InputJsonValue | undefined {
    if (metadata == null) return undefined;
    try {
      return JSON.parse(JSON.stringify(metadata)) as Prisma.InputJsonValue;
    } catch {
      return undefined;
    }
  }
}
