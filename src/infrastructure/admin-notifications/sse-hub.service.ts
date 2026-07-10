import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { Response } from 'express';
import { AdminNotificationMetrics } from './admin-notification.metrics';

const HEARTBEAT_MS = 30_000;
const DEFAULT_MAX_CONNECTION_AGE_MINUTES = 60;

/** Per-connection lifecycle metadata (ML-1). */
interface SseConnection {
  res: Response;
  connectedAt: number;
  lastHeartbeatAt: number;
  lastWriteAt: number;
}

function maxAgeMsFromEnv(): number {
  const minutes = Number(process.env.SSE_MAX_CONNECTION_AGE_MINUTES);
  const safe = Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_MAX_CONNECTION_AGE_MINUTES;
  return Math.trunc(safe) * 60_000;
}

/**
 * Server-Sent-Events hub for admin realtime updates. Multiple tabs per admin are
 * supported (per-admin connection sets); a 30s heartbeat keeps proxies from
 * idling connections out; closed connections are cleaned up immediately.
 *
 * ML-1: connections also carry lifecycle metadata (connectedAt / lastHeartbeatAt /
 * lastWriteAt). The heartbeat sweep gracefully `end()`s any connection older than
 * SSE_MAX_CONNECTION_AGE_MINUTES (default 60) so a half-open socket behind a
 * non-signaling proxy can never be retained forever — a healthy client simply
 * auto-reconnects (`retry: 3000`) and is never closed before the max age.
 */
@Injectable()
export class SseHubService implements OnModuleDestroy {
  private readonly logger = new Logger('SseHubService');
  private readonly connections = new Map<string, Map<Response, SseConnection>>();
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly maxAgeMs = maxAgeMsFromEnv();

  constructor(private readonly metrics: AdminNotificationMetrics) {}

  register(adminId: string, res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write('retry: 3000\n\n'); // EventSource auto-reconnect hint

    const now = Date.now();
    const set = this.connections.get(adminId) ?? new Map<Response, SseConnection>();
    set.set(res, { res, connectedAt: now, lastHeartbeatAt: now, lastWriteAt: now });
    this.connections.set(adminId, set);
    this.metrics.sseConnected();
    this.ensureHeartbeat();

    res.req?.on('close', () => this.unregister(adminId, res));
  }

  private unregister(adminId: string, res: Response): void {
    const set = this.connections.get(adminId);
    if (!set?.delete(res)) return;
    if (set.size === 0) this.connections.delete(adminId);
    this.metrics.sseDisconnected();
    if (this.connections.size === 0 && this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  /** Send an event to specific admins (or every connected admin when null). */
  broadcast(adminIds: string[] | null, event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const now = Date.now();
    const targets = adminIds ?? [...this.connections.keys()];
    for (const adminId of targets) {
      for (const conn of this.connections.get(adminId)?.values() ?? []) {
        try {
          conn.res.write(payload);
          conn.lastWriteAt = now;
        } catch {
          this.unregister(adminId, conn.res);
        }
      }
    }
  }

  activeConnections(): number {
    let n = 0;
    for (const set of this.connections.values()) n += set.size;
    return n;
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => this.heartbeatTick(Date.now()), HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  /**
   * One sweep: recycle connections past the max lifetime, heartbeat the rest.
   * Separate method so lifecycle behavior is unit-testable without fake timers.
   */
  heartbeatTick(now: number): void {
    for (const [adminId, set] of this.connections) {
      for (const conn of [...set.values()]) {
        // Graceful max-age recycle (ML-1): end() triggers the client's automatic
        // reconnect; the req 'close' handler (or this unregister) drops the entry
        // so the Response is never retained past the lifetime cap.
        if (now - conn.connectedAt >= this.maxAgeMs) {
          try {
            conn.res.end();
          } catch {
            // socket already dead — unregister below either way
          }
          this.unregister(adminId, conn.res);
          this.logger.log(`SSE connection recycled after max age (admin=${adminId})`);
          continue;
        }
        try {
          conn.res.write(': heartbeat\n\n');
          conn.lastHeartbeatAt = now;
          conn.lastWriteAt = now;
        } catch {
          this.unregister(adminId, conn.res);
        }
      }
    }
  }

  onModuleDestroy(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const set of this.connections.values()) {
      for (const conn of set.values()) {
        try {
          conn.res.end();
        } catch {
          // closing anyway
        }
      }
    }
    this.connections.clear();
  }
}
