import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AdminUser, CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { AdminGuard } from '../../../common/guards/admin.guard';
import { PermissionGuard } from '../../../common/guards/permission.guard';
import { AdjustStockDto, CreateTransferDto, ListInventoryQueryDto, ListTransfersQueryDto } from '../application/dto/inventory-admin.dto';
import { StockTransferService } from '../stock-transfer.service';

@ApiTags('admin-inventory')
@UseGuards(AdminGuard, PermissionGuard)
@Controller({ path: 'admin', version: '1' })
export class InventoryAdminController {
  constructor(private readonly service: StockTransferService) {}

  // --- Product / outlet inventory ---
  @Permissions('ProductInventory.read')
  @Get('product-inventory')
  listInventory(@Query() query: ListInventoryQueryDto) {
    return this.service.listInventory(query);
  }

  @Permissions('ProductInventory.read')
  @Get('inventory-report')
  report() {
    return this.service.inventoryReport();
  }

  @Permissions('ProductInventory.update')
  @Post('product-inventory/adjust')
  adjust(@Body() dto: AdjustStockDto, @CurrentAdmin() admin: AdminUser) {
    return this.service.adjustStock(dto, admin.sub);
  }

  // --- Stock transfers ---
  @Permissions('StockTransfer.read')
  @Get('stock-transfers')
  listTransfers(@Query() query: ListTransfersQueryDto) {
    return this.service.listTransfers(query);
  }

  @Permissions('StockTransfer.read')
  @Get('stock-transfers/:id')
  getTransfer(@Param('id') id: string) {
    return this.service.getTransfer(id);
  }

  @Permissions('StockTransfer.create')
  @Post('stock-transfers')
  request(@Body() dto: CreateTransferDto, @CurrentAdmin() admin: AdminUser) {
    return this.service.requestTransfer(dto, admin.sub);
  }

  @Permissions('StockTransfer.update')
  @Patch('stock-transfers/:id/approve')
  approve(@Param('id') id: string, @CurrentAdmin() admin: AdminUser) {
    return this.service.approveTransfer(id, admin.sub);
  }

  @Permissions('StockTransfer.update')
  @Patch('stock-transfers/:id/complete')
  complete(@Param('id') id: string, @CurrentAdmin() admin: AdminUser) {
    return this.service.completeTransfer(id, admin.sub);
  }
}
