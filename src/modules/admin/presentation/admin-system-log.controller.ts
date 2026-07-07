import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { AdminGuard } from '../../../common/guards/admin.guard';
import { PermissionGuard } from '../../../common/guards/permission.guard';
import { SystemLogQueryService } from '../../../infrastructure/logging/system-log-query.service';
import { SystemDashboardService } from '../../../infrastructure/logging/system-dashboard.service';
import { ListSystemLogsQueryDto } from '../application/dto/system-log-query.dto';

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
  ) {}

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
