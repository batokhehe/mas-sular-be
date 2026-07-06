import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { AdminGuard } from '../../../common/guards/admin.guard';
import { PermissionGuard } from '../../../common/guards/permission.guard';
import {
  CreateDeliveryCoverageDto,
  ListCoverageQueryDto,
  UpdateDeliveryCoverageDto,
} from '../application/dto/delivery-coverage.dto';
import { DeliveryCoverageService } from '../delivery-coverage.service';

class SetActiveDto {
  isActive!: boolean;
}

@ApiTags('admin-delivery-coverage')
@UseGuards(AdminGuard, PermissionGuard)
@Controller({ path: 'admin/delivery-coverage', version: '1' })
export class AdminDeliveryCoverageController {
  constructor(private readonly service: DeliveryCoverageService) {}

  @Permissions('DeliveryCoverage.read')
  @Get()
  list(@Query() query: ListCoverageQueryDto) {
    return this.service.list(query);
  }

  @Permissions('DeliveryCoverage.read')
  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.service.getById(id);
  }

  @Permissions('DeliveryCoverage.create')
  @Post()
  create(@Body() dto: CreateDeliveryCoverageDto) {
    return this.service.create(dto);
  }

  @Permissions('DeliveryCoverage.update')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateDeliveryCoverageDto) {
    return this.service.update(id, dto);
  }

  @Permissions('DeliveryCoverage.update')
  @Patch(':id/active')
  setActive(@Param('id') id: string, @Body() dto: SetActiveDto) {
    return this.service.setActive(id, dto.isActive);
  }

  @Permissions('DeliveryCoverage.delete')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
