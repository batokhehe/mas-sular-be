import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { AdminGuard } from '../../../common/guards/admin.guard';
import { PermissionGuard } from '../../../common/guards/permission.guard';
import { ListReservationsQueryDto } from '../application/dto/inventory-reservation-query.dto';
import { InventoryReservationService } from '../inventory-reservation.service';

@ApiTags('admin-inventory-reservations')
@UseGuards(AdminGuard, PermissionGuard)
@Controller({ path: 'admin/inventory-reservations', version: '1' })
export class InventoryReservationAdminController {
  constructor(private readonly reservations: InventoryReservationService) {}

  @Permissions('InventoryReservation.read')
  @Get()
  list(@Query() query: ListReservationsQueryDto) {
    return this.reservations.listReservations(query);
  }

  @Permissions('InventoryReservation.read')
  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.reservations.getReservation(id);
  }
}
