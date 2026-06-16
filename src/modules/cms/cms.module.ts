import { Module } from '@nestjs/common';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { CmsController } from './presentation/cms.controller';

@Module({ controllers: [CmsController], providers: [PermissionGuard] })
export class CmsModule {}
