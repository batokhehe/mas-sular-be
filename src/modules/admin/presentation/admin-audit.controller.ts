import { Body, Controller, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { AdminGuard } from '../../../common/guards/admin.guard';
import { PermissionGuard } from '../../../common/guards/permission.guard';
import { AuditTrailService } from '../../../infrastructure/audit/audit-trail.service';
import { ListAuditQueryDto } from '../application/dto/audit-query.dto';

/**
 * Enterprise Audit Trail — read-only viewing (`Audit.read`) + CSV export
 * (`Audit.export`). Recording itself is done by the global interceptor.
 */
@ApiTags('admin-audit')
@UseGuards(AdminGuard, PermissionGuard)
@Controller({ path: 'admin/system/audit', version: '1' })
export class AdminAuditController {
  constructor(private readonly audit: AuditTrailService) {}

  @Permissions('Audit.read')
  @Get()
  list(@Query() query: ListAuditQueryDto) {
    return this.audit.list(query);
  }

  @Permissions('Audit.read')
  @Get(':id')
  detail(@Param('id') id: string) {
    return this.audit.detail(id);
  }

  // CSV export — streamed in batches. Filters mirror the list query.
  @Permissions('Audit.export')
  @Post('export')
  export(@Body() query: ListAuditQueryDto, @Res() res: Response) {
    return this.audit.exportCsv(query, res);
  }
}
