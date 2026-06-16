import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';

/**
 * Central Prometheus registry. The metric seams (RelayMetrics, NotificationMetrics,
 * LifecycleMetrics) create their metrics through here so names are registered once,
 * and dual-emit alongside their existing structured logs. No default Node metrics
 * are collected (kept deliberately minimal for this phase).
 */
@Injectable()
export class MetricsRegistry {
  readonly registry = new Registry();
  readonly contentType: string = this.registry.contentType;

  private readonly counters = new Map<string, Counter<string>>();
  private readonly gauges = new Map<string, Gauge<string>>();
  private readonly histograms = new Map<string, Histogram<string>>();

  constructor() {
    this.setBuildInfo(process.env.APP_VERSION ?? process.env.npm_package_version ?? '0.0.0', process.env.NODE_ENV ?? 'development');
  }

  counter(name: string, help: string, labelNames: string[] = []): Counter<string> {
    let metric = this.counters.get(name);
    if (!metric) {
      metric = new Counter({ name, help, labelNames, registers: [this.registry] });
      this.counters.set(name, metric);
    }
    return metric;
  }

  gauge(name: string, help: string, labelNames: string[] = []): Gauge<string> {
    let metric = this.gauges.get(name);
    if (!metric) {
      metric = new Gauge({ name, help, labelNames, registers: [this.registry] });
      this.gauges.set(name, metric);
    }
    return metric;
  }

  histogram(name: string, help: string, buckets?: number[], labelNames: string[] = []): Histogram<string> {
    let metric = this.histograms.get(name);
    if (!metric) {
      metric = new Histogram({ name, help, labelNames, buckets, registers: [this.registry] });
      this.histograms.set(name, metric);
    }
    return metric;
  }

  setBuildInfo(version: string, environment: string): void {
    this.gauge('masular_build_info', 'Build/version info', ['version', 'environment']).set({ version, environment }, 1);
  }

  expose(): Promise<string> {
    return this.registry.metrics();
  }
}
