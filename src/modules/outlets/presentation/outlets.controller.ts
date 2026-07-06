import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { AdminGuard } from '../../../common/guards/admin.guard';
import { PermissionGuard } from '../../../common/guards/permission.guard';
import { CreateOutletDto, UpdateOutletDto } from '../application/dto/outlet.dto';
import { OutletService } from '../outlet.service';

@ApiTags('admin-outlets')
@UseGuards(AdminGuard, PermissionGuard)
@Controller({ path: 'admin/outlets', version: '1' })
export class OutletsController {
  constructor(private readonly service: OutletService) {}

  @Permissions('Outlet.read')
  @Get()
  list() {
    return this.service.list();
  }

  @Permissions('Outlet.read')
  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.service.getById(id);
  }

  @Permissions('Outlet.create')
  @Post()
  create(@Body() dto: CreateOutletDto) {
    return this.service.create(dto);
  }

  @Permissions('Outlet.update')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateOutletDto) {
    return this.service.update(id, dto);
  }

  @Permissions('Outlet.activate')
  @Patch(':id/activate')
  activate(@Param('id') id: string) {
    return this.service.activate(id);
  }

  @Permissions('Outlet.delete')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
