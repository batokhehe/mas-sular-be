import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { Response } from 'express';
import { AdminNotificationMetrics } from './admin-notification.metrics';

const HEARTBEAT_MS = 30_000;

/**
 * Server-Sent-Events hub for admin realtime updates. Multiple tabs per admin are
 * supported (a Set of connections per adminId); a 30s heartbeat keeps proxies
 * from idling connections out; closed connections are cleaned up immediately.
 */
@Injectable()
export class SseHubService implements OnModuleDestroy {
  private readonly logger = new Logger('SseHubService');
  private readonly connections = new Map<string, Set<Response>>();
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(private readonly metrics: AdminNotificationMetrics) {}

  register(adminId: string, res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write('retry: 3000\n\n'); // EventSource auto-reconnect hint

    const set = this.connections.get(adminId) ?? new Set<Response>();
    set.add(res);
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
    const targets = adminIds ?? [...this.connections.keys()];
    for (const adminId of targets) {
      for (const res of this.connections.get(adminId) ?? []) {
        try {
          res.write(payload);
        } catch {
          this.unregister(adminId, res);
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
    this.heartbeat = setInterval(() => {
      for (const [adminId, set] of this.connections) {
        for (const res of set) {
          try {
            res.write(': heartbeat\n\n');
          } catch {
            this.unregister(adminId, res);
          }
        }
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  onModuleDestroy(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const set of this.connections.values()) {
      for (const res of set) {
        try {
          res.end();
        } catch {
          // closing anyway
        }
      }
    }
    this.connections.clear();
  }
}
