import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { PaymentStatus } from '@prisma/client';
import { ApiTags } from '@nestjs/swagger';
import { AdminUser, CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { AdminGuard } from '../../../common/guards/admin.guard';
import { PermissionGuard } from '../../../common/guards/permission.guard';
import { AdminService } from '../admin.service';
import {
  CreateShipmentDto,
  ListAdminOrdersQueryDto,
  ListAdminShipmentsQueryDto,
  RejectAdminPaymentDto,
  UpdateOrderStatusDto,
  UpdateShipmentDto,
  VerifyAdminPaymentDto,
} from '../application/dto/admin-operations.dto';
import { CreateRoleDto } from '../application/dto/create-role.dto';
import { UpdateRoleDto } from '../application/dto/update-role.dto';
import { UpdateUserDto } from '../application/dto/update-user.dto';

@ApiTags('admin-operations')
@UseGuards(AdminGuard, PermissionGuard)
@Controller({ path: 'admin', version: '1' })
export class AdminOperationsController {
  constructor(private readonly adminService: AdminService) {}

  @Permissions('Dashboard.read')
  @Get('dashboard')
  dashboard() {
    return this.adminService.getDashboard();
  }

  @Permissions('Order.read')
  @Get('orders')
  listOrders(@Query() query: ListAdminOrdersQueryDto) {
    return this.adminService.listOrders(query);
  }

  @Permissions('Order.read')
  @Get('orders/:id')
  getOrder(@Param('id') id: string) {
    return this.adminService.getOrder(id);
  }

  @Permissions('Order.update')
  @Patch('orders/:id/status')
  updateOrderStatus(@Param('id') id: string, @Body() dto: UpdateOrderStatusDto) {
    return this.adminService.updateOrderStatus(id, dto);
  }

  @Permissions('Payment.read')
  @Get('payments')
  listPayments(@Query('status') status?: PaymentStatus) {
    return this.adminService.listPayments(status);
  }

  @Permissions('Payment.read')
  @Get('payments/pending-verification')
  listPendingPaymentVerification() {
    return this.adminService.listPayments();
  }

  @Permissions('Payment.verify')
  @Patch('payments/:paymentId/verify')
  verifyPayment(
    @Param('paymentId') paymentId: string,
    @CurrentAdmin() admin: AdminUser,
    @Body() dto: VerifyAdminPaymentDto,
  ) {
    return this.adminService.verifyPayment(paymentId, admin.sub, dto);
  }

  @Permissions('Payment.reject')
  @Patch('payments/:paymentId/reject')
  rejectPayment(@Param('paymentId') paymentId: string, @Body() dto: RejectAdminPaymentDto) {
    return this.adminService.rejectPayment(paymentId, dto);
  }

  @Permissions('Shipment.create')
  @Post('shipments')
  createShipment(@Body() dto: CreateShipmentDto) {
    return this.adminService.createShipment(dto);
  }

  @Permissions('Shipment.read')
  @Get('shipments')
  listShipments(@Query() query: ListAdminShipmentsQueryDto) {
    return this.adminService.listShipments(query);
  }

  @Permissions('Shipment.read')
  @Get('shipments/:id')
  getShipment(@Param('id') id: string) {
    return this.adminService.getShipment(id);
  }

  @Permissions('Shipment.update')
  @Patch('shipments/:id')
  updateShipment(@Param('id') id: string, @Body() dto: UpdateShipmentDto) {
    return this.adminService.updateShipment(id, dto);
  }

  @Permissions('Shipment.delete')
  @Delete('shipments/:id')
  deleteShipment(@Param('id') id: string) {
    return this.adminService.deleteShipment(id);
  }

  @Permissions('User.read')
  @Get('users')
  listUsers() {
    return this.adminService.listUsers();
  }

  @Permissions('User.read')
  @Get('users/:id')
  getUser(@Param('id') id: string) {
    return this.adminService.getUser(id);
  }

  @Permissions('User.update')
  @Patch('users/:id')
  updateUser(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.adminService.updateUser(id, dto);
  }

  @Permissions('Role.create')
  @Post('roles')
  createRole(@Body() dto: CreateRoleDto) {
    return this.adminService.createRole(dto);
  }

  @Permissions('Role.read')
  @Get('roles')
  listRoles() {
    return this.adminService.listRoles();
  }

  @Permissions('Role.read')
  @Get('roles/:id')
  getRole(@Param('id') id: string) {
    return this.adminService.getRole(id);
  }

  @Permissions('Role.update')
  @Patch('roles/:id')
  updateRole(@Param('id') id: string, @Body() dto: UpdateRoleDto) {
    return this.adminService.updateRole(id, dto);
  }

  @Permissions('Role.read')
  @Get('permissions')
  listPermissions() {
    return this.adminService.listPermissions();
  }
}
