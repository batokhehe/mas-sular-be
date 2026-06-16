import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../../database/prisma.service';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { AdminGuard } from '../../../common/guards/admin.guard';
import { PermissionGuard } from '../../../common/guards/permission.guard';
import { AuditQueryDto } from '../application/dto/audit-query.dto';

@ApiTags('audit')
@ApiBearerAuth()
@UseGuards(AdminGuard, PermissionGuard)
@Controller({ path: 'audit-logs', version: '1' })
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Permissions('AuditLog.read')
  list(@Query() query: AuditQueryDto) {
    return this.prisma.auditLog.findMany({
      where: { entity: query.entity },
      include: { actor: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }
}
