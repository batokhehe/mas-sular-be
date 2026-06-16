import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AdminGuard } from '../../../common/guards/admin.guard';
import { PermissionGuard } from '../../../common/guards/permission.guard';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { AdminService } from '../admin.service';
import { CreateBannerDto } from '../../cms/application/dto/banner.dto';
import { UpdateBannerDto } from '../application/dto/update-banner.dto';

@ApiTags('admin-cms')
@UseGuards(AdminGuard, PermissionGuard)
@Controller({ path: 'admin/cms', version: '1' })
export class AdminCmsController {
  constructor(private readonly adminService: AdminService) {}

  @Permissions('Banner.create')
  @Post('banners')
  createBanner(@Body() dto: CreateBannerDto) {
    return this.adminService.createBanner(dto);
  }

  @Permissions('Banner.read')
  @Get('banners')
  listBanners() {
    return this.adminService.listBanners();
  }

  @Permissions('Banner.read')
  @Get('banners/:id')
  getBanner(@Param('id') id: string) {
    return this.adminService.getBanner(id);
  }

  @Permissions('Banner.update')
  @Patch('banners/:id')
  updateBanner(@Param('id') id: string, @Body() dto: UpdateBannerDto) {
    return this.adminService.updateBanner(id, dto);
  }

  @Permissions('Banner.delete')
  @Delete('banners/:id')
  deleteBanner(@Param('id') id: string) {
    return this.adminService.deleteBanner(id);
  }
}
