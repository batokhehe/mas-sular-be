import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import { LogLevel } from '@prisma/client';
import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { redactSensitivePath } from '../../common/logging/redact';
import { LOG_CONFIG, LogConfig } from './log.config';
import { LogService } from './log.service';
import { runWithRequestContext } from './request-context';

// Noise endpoints excluded from per-request logging (health checks / scrapes / docs).
const SKIP_PREFIXES = ['/api/v1/health', '/metrics', '/docs', '/api/v1/health/ready', '/api/v1/health/live'];

interface ReqUser {
  sub?: string;
  permissions?: string[];
}

/**
 * Assigns every request a `requestId` (reusing an inbound `X-Request-Id` or a fresh
 * UUID), runs the rest of the pipeline inside an AsyncLocalStorage context so all
 * logs share it, and — on response finish — writes ONE `http/request.finished`
 * SystemLog row (level by status). Fire-and-forget; never blocks the response.
 */
@Injectable()
export class RequestLoggingMiddleware implements NestMiddleware {
  constructor(
    private readonly logs: LogService,
    @Inject(LOG_CONFIG) private readonly config: LogConfig,
  ) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const rawPath = (req.originalUrl ?? req.url ?? '').split('?')[0];
    if (!this.config.enabled || SKIP_PREFIXES.some((p) => rawPath === p || rawPath.startsWith(`${p}/`))) {
      next();
      return;
    }

    const requestId = String((req.headers['x-request-id'] as string | undefined) ?? randomUUID());
    const path = redactSensitivePath(rawPath);
    const ip = this.clientIp(req);
    res.setHeader('X-Request-Id', requestId);
    const startedAt = Date.now();
    const isAdmin = rawPath.includes('/admin/');

    res.on('finish', () => {
      const status = res.statusCode;
      const level = status >= 500 ? LogLevel.ERROR : status >= 400 ? LogLevel.WARN : LogLevel.INFO;
      const user = (req as Request & { user?: ReqUser }).user;
      const p = (req.params ?? {}) as Record<string, string | undefined>;
      this.logs.write({
        level,
        module: 'http',
        action: 'request.finished',
        message: `${req.method} ${path} ${status}`,
        requestId,
        ip,
        method: req.method,
        path,
        statusCode: status,
        durationMs: Date.now() - startedAt,
        userId: !isAdmin ? user?.sub ?? null : null,
        adminId: isAdmin ? user?.sub ?? null : null,
        orderId: p.orderId ?? (rawPath.includes('/orders/') ? p.id : undefined) ?? null,
        paymentId: p.paymentId ?? null,
        shipmentId: p.shipmentId ?? null,
        metadata: { query: req.query, params: p, userAgent: req.headers['user-agent'] ?? null },
      });
    });

    runWithRequestContext(
      { requestId, ip, method: req.method, path, userId: isAdmin ? null : undefined, adminId: isAdmin ? undefined : null },
      () => next(),
    );
  }

  private clientIp(req: Request): string | null {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
    return req.ip ?? req.socket?.remoteAddress ?? null;
  }
}
