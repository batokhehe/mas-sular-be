import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { PaymentStatus } from '@prisma/client';
import { ApiTags } from '@nestjs/swagger';
import { AdminUser, CurrentAdmin } from '../../../common/decorators/current-admin.decorator';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { AdminGuard } from '../../../common/guards/admin.guard';
import { PermissionGuard } from '../../../common/guards/permission.guard';
import { AdminService } from '../admin.service';
import { ExecutiveDashboardService } from '../executive-dashboard.service';
import { AdminOrderNotesService } from '../admin-order-notes.service';
import { ShipmentService } from '../../shipment/shipment.service';
import {
  CreateShipmentDto,
  ListAdminOrdersQueryDto,
  ListAdminShipmentsQueryDto,
  RejectAdminPaymentDto,
  UpdateOrderStatusDto,
  UpdateShipmentDto,
  VerifyAdminPaymentDto,
} from '../application/dto/admin-operations.dto';
import { CreateOrderNoteDto, UpdateOrderNoteDto } from '../application/dto/order-note.dto';
import { CreateRoleDto } from '../application/dto/create-role.dto';
import { UpdateRoleDto } from '../application/dto/update-role.dto';
import { UpdateUserDto } from '../application/dto/update-user.dto';

@ApiTags('admin-operations')
@UseGuards(AdminGuard, PermissionGuard)
@Controller({ path: 'admin', version: '1' })
export class AdminOperationsController {
  constructor(
    private readonly adminService: AdminService,
    private readonly executiveDashboard: ExecutiveDashboardService,
    private readonly orderNotes: AdminOrderNotesService,
    // Cancellation talks to the courier, which is ShipmentService's job — the
    // same collaborator the retry and prepare actions already go through.
    private readonly shipments: ShipmentService,
  ) {}

  @Permissions('Dashboard.read')
  @Get('dashboard')
  dashboard() {
    return this.adminService.getDashboard();
  }

  // Executive dashboard: one aggregated, 30s-cached payload for every widget.
  @Permissions('Dashboard.read')
  @Get('dashboard/executive')
  executiveDashboardData() {
    return this.executiveDashboard.getDashboard();
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

  // Read-only operations-center bundle (history, timeline, actions, audit, notifications).
  @Permissions('Order.read')
  @Get('orders/:id/operations')
  orderOperations(@Param('id') id: string) {
    return this.adminService.getOrderOperations(id);
  }

  // ---- Internal notes (admin-only annotations; isolated from business flows) ----
  @Permissions('Order.read')
  @Get('orders/:id/notes')
  listOrderNotes(@Param('id') id: string) {
    return this.orderNotes.list(id);
  }

  @Permissions('Order.update')
  @Post('orders/:id/notes')
  createOrderNote(@Param('id') id: string, @CurrentAdmin() admin: AdminUser, @Body() dto: CreateOrderNoteDto) {
    return this.orderNotes.create(id, { id: admin.sub, name: admin.name }, dto);
  }

  @Permissions('Order.update')
  @Patch('orders/:id/notes/:noteId')
  updateOrderNote(
    @Param('id') id: string,
    @Param('noteId') noteId: string,
    @CurrentAdmin() admin: AdminUser,
    @Body() dto: UpdateOrderNoteDto,
  ) {
    return this.orderNotes.update(id, noteId, admin.sub, dto);
  }

  @Permissions('Order.update')
  @Delete('orders/:id/notes/:noteId')
  deleteOrderNote(@Param('id') id: string, @Param('noteId') noteId: string, @CurrentAdmin() admin: AdminUser) {
    return this.orderNotes.remove(id, noteId, admin.sub);
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
  listPendingPaymentVerification(@Query('search') search?: string) {
    return this.adminService.listPayments(PaymentStatus.WAITING_VERIFICATION, search);
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

  /**
   * Cancel the courier booking, then record it locally.
   *
   * A separate endpoint from PATCH on purpose: this one leaves the application
   * and changes something in the outside world, so it must be asked for
   * explicitly rather than falling out of a status field on an edit form. It
   * takes no body — the courier handle is read from the persisted shipment, so
   * no caller can direct the cancellation at some other parcel.
   *
   * `Shipment.update` rather than `Shipment.delete`: this is an operational
   * state change, not a deletion, and the row survives it. It also grants no
   * new authority — anyone who can already reach PATCH could already set the
   * status to CANCELLED by hand; this gives them the version that actually
   * tells the courier.
   */
  @Permissions('Shipment.update')
  @Post('shipments/:id/cancel')
  cancelShipment(@Param('id') id: string) {
    return this.shipments.cancelForShipment(id);
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
