import { Global, Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsRegistry } from './metrics.registry';
import { RelayMetrics } from './relay.metrics';

/**
 * Global Prometheus registry. The relay/notification/lifecycle metric seams
 * inject MetricsRegistry to register and increment instruments; RelayMetrics is
 * exported for the outbox relay worker.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsRegistry, RelayMetrics],
  exports: [MetricsRegistry, RelayMetrics],
})
export class MetricsModule {}
