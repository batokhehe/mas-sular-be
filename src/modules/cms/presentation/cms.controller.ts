import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../../database/prisma.service';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { AdminGuard } from '../../../common/guards/admin.guard';
import { PermissionGuard } from '../../../common/guards/permission.guard';
import { CreateBannerDto } from '../application/dto/banner.dto';

@ApiTags('cms')
@Controller({ path: 'cms', version: '1' })
export class CmsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('banners')
  banners(@Query('placement') placement?: string) {
    return this.prisma.banner.findMany({
      where: { deletedAt: null, isActive: true, placement },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    });
  }

  @Post('banners')
  @ApiBearerAuth()
  @UseGuards(AdminGuard, PermissionGuard)
  @Permissions('Banner.create')
  createBanner(@Body() dto: CreateBannerDto) {
    return this.prisma.banner.create({ data: { ...dto, isActive: dto.isActive ?? true } });
  }
}
