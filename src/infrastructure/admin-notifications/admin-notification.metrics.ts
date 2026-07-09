import { Injectable } from '@nestjs/common';

/** In-process counters/gauges for the notification platform (observability). */
@Injectable()
export class AdminNotificationMetrics {
  private counters = { created: 0, pushSuccess: 0, pushFailed: 0, consumed: 0, duplicates: 0, deadLettered: 0 };
  private sse = { active: 0 };
  private latency = { totalMs: 0, samples: 0 };

  created(count = 1): void {
    this.counters.created += count;
  }
  pushSuccess(): void {
    this.counters.pushSuccess += 1;
  }
  pushFailed(): void {
    this.counters.pushFailed += 1;
  }
  consumed(): void {
    this.counters.consumed += 1;
  }
  duplicate(): void {
    this.counters.duplicates += 1;
  }
  deadLettered(): void {
    this.counters.deadLettered += 1;
  }
  sseConnected(): void {
    this.sse.active += 1;
  }
  sseDisconnected(): void {
    this.sse.active = Math.max(0, this.sse.active - 1);
  }
  observeProcessing(ms: number): void {
    this.latency.totalMs += ms;
    this.latency.samples += 1;
  }

  snapshot() {
    return {
      activeSseConnections: this.sse.active,
      notificationsCreated: this.counters.created,
      eventsConsumed: this.counters.consumed,
      duplicates: this.counters.duplicates,
      deadLettered: this.counters.deadLettered,
      pushSuccess: this.counters.pushSuccess,
      pushFailed: this.counters.pushFailed,
      avgProcessingMs: this.latency.samples ? Math.round(this.latency.totalMs / this.latency.samples) : 0,
    };
  }
}
