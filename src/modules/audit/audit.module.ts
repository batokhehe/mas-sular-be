import { Module } from '@nestjs/common';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { AuditController } from './presentation/audit.controller';

@Module({ controllers: [AuditController], providers: [PermissionGuard] })
export class AuditModule {}
