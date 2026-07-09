import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { AdminGuard } from '../../../common/guards/admin.guard';
import { PermissionGuard } from '../../../common/guards/permission.guard';
import { SystemLogQueryService } from '../../../infrastructure/logging/system-log-query.service';
import { SystemDashboardService } from '../../../infrastructure/logging/system-dashboard.service';
import { RequestExplorerService } from '../../../infrastructure/logging/request-explorer.service';
import { PerformanceProfilerService, PerfRange, PERF_RANGES } from '../../../infrastructure/logging/performance-profiler.service';
import { ListSystemLogsQueryDto } from '../application/dto/system-log-query.dto';
import { ListRequestsQueryDto } from '../application/dto/request-explorer-query.dto';

/**
 * Enterprise logging center — read-only search + detail. Gated by the dedicated
 * `SystemLog.read` permission (Dashboard.read is NOT sufficient). Always paginated.
 */
@ApiTags('admin-system-logs')
@UseGuards(AdminGuard, PermissionGuard)
@Controller({ path: 'admin/system', version: '1' })
export class AdminSystemLogController {
  constructor(
    private readonly logs: SystemLogQueryService,
    private readonly dashboard: SystemDashboardService,
    private readonly requests: RequestExplorerService,
    private readonly performance: PerformanceProfilerService,
  ) {}

  // Performance Profiler: 30s-cached latency/throughput profile per time range.
  @Permissions('SystemLog.read')
  @Get('performance')
  performanceProfile(@Query('range') range?: string) {
    const valid: PerfRange = range && range in PERF_RANGES ? (range as PerfRange) : '24h';
    return this.performance.profile(valid);
  }

  // Request Explorer: paginated request list (one row per http request).
  @Permissions('SystemLog.read')
  @Get('requests')
  listRequests(@Query() query: ListRequestsQueryDto) {
    return this.requests.list(query);
  }

  // Request Explorer: full lifecycle of one request (summary + timeline + related).
  @Permissions('SystemLog.read')
  @Get('requests/:requestId')
  requestDetail(@Param('requestId') requestId: string) {
    return this.requests.detail(requestId);
  }

  // Observability dashboard: one aggregated, 30s-cached payload for every metric.
  @Permissions('SystemLog.read')
  @Get('dashboard')
  systemDashboard() {
    return this.dashboard.getDashboard();
  }

  @Permissions('SystemLog.read')
  @Get('logs')
  list(@Query() query: ListSystemLogsQueryDto) {
    return this.logs.list(query);
  }

  @Permissions('SystemLog.read')
  @Get('logs/:id')
  detail(@Param('id') id: string) {
    return this.logs.get(id);
  }
}
