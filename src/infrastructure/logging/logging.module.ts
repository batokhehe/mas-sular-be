import { Global, Module } from '@nestjs/common';
import { LOG_CONFIG, loadLogConfig } from './log.config';
import { LogService } from './log.service';
import { SystemLogQueryService } from './system-log-query.service';
import { SystemDashboardService } from './system-dashboard.service';
import { RequestExplorerService } from './request-explorer.service';
import { PerformanceProfilerService } from './performance-profiler.service';
import { IncidentCenterService } from './incident-center.service';
import { RequestLoggingMiddleware } from './request-logging.middleware';
import { LogRetentionWorker } from './log-retention.worker';

/**
 * Global logging center (additive). Provides LogService (durable structured logs),
 * the search/detail query service, the request-correlation middleware, and the
 * retention worker. Global so any module/worker can inject LogService without an
 * explicit import. Does NOT touch the Pino logger.
 *
 * The RequestLoggingMiddleware is applied in main.ts via `app.use(...)` (not
 * `forRoutes('*')`) so it wraps every request without depending on Express-5
 * wildcard path matching.
 */
@Global()
@Module({
  providers: [
    { provide: LOG_CONFIG, useFactory: () => loadLogConfig() },
    LogService,
    SystemLogQueryService,
    SystemDashboardService,
    RequestExplorerService,
    PerformanceProfilerService,
    IncidentCenterService,
    RequestLoggingMiddleware,
    LogRetentionWorker,
  ],
  exports: [LogService, SystemLogQueryService, SystemDashboardService, RequestExplorerService, PerformanceProfilerService, IncidentCenterService, RequestLoggingMiddleware],
})
export class LoggingModule {}
