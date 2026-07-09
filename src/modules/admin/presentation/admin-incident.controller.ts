import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AdminUser, CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { AdminGuard } from '../../../common/guards/admin.guard';
import { PermissionGuard } from '../../../common/guards/permission.guard';
import { IncidentCenterService } from '../../../infrastructure/logging/incident-center.service';
import { ListIncidentsQueryDto } from '../application/dto/incident-query.dto';

/**
 * Incident Center. Reads gated by `Incident.read`; lifecycle actions (acknowledge/
 * resolve) by `Incident.manage`. Listing runs the 30s-throttled auto-detection
 * sweep first, so incidents appear without any manual trigger.
 */
@ApiTags('admin-incidents')
@UseGuards(AdminGuard, PermissionGuard)
@Controller({ path: 'admin/system/incidents', version: '1' })
export class AdminIncidentController {
  constructor(private readonly incidents: IncidentCenterService) {}

  @Permissions('Incident.read')
  @Get()
  list(@Query() query: ListIncidentsQueryDto) {
    return this.incidents.list(query);
  }

  @Permissions('Incident.read')
  @Get(':id')
  detail(@Param('id') id: string) {
    return this.incidents.detail(id);
  }

  @Permissions('Incident.manage')
  @Post(':id/acknowledge')
  acknowledge(@Param('id') id: string, @CurrentAdmin() admin: AdminUser) {
    return this.incidents.acknowledge(id, admin.sub);
  }

  @Permissions('Incident.manage')
  @Post(':id/resolve')
  resolve(@Param('id') id: string, @CurrentAdmin() admin: AdminUser) {
    return this.incidents.resolve(id, admin.sub);
  }
}
