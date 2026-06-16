import { Controller, Get, Header, VERSION_NEUTRAL } from '@nestjs/common';
import { MetricsRegistry } from './metrics.registry';

/**
 * Prometheus scrape endpoint. Version-neutral and excluded from the global API
 * prefix in main.ts so it is served at GET /metrics. Internal-only: no auth is
 * implemented in this phase — expose only on a trusted network / internal port.
 */
@Controller({ path: 'metrics', version: VERSION_NEUTRAL })
export class MetricsController {
  constructor(private readonly metrics: MetricsRegistry) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(): Promise<string> {
    return this.metrics.expose();
  }
}
