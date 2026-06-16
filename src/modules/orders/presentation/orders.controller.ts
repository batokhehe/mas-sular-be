import { Controller, ForbiddenException, Get, Param, Post, Query, UseGuards, Body } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { ValidateVoucherDto } from '../application/dto/create-order.dto';
import { OrdersService } from '../orders.service';

@ApiTags('orders')
@Controller({ path: 'orders', version: '1' })
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  // NOTE: order creation lives ONLY on POST /checkout/order (CheckoutController),
  // which runs the idempotent, fence-tokened orchestration. The previous
  // POST /orders/checkout bypassed idempotency (duplicate-order risk) and has
  // been removed — all checkout requests must go through /checkout/order.

  @Post('voucher/preview')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  previewVoucher(@CurrentUser() user: AuthUser, @Body() dto: ValidateVoucherDto) {
    return this.orders.previewVoucher(user.sub, dto);
  }

  @Get('users/:userId')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  listForUser(
    @CurrentUser() user: AuthUser,
    @Param('userId') userId: string,
    @Query('status') status?: string,
  ) {
    if (user.sub !== userId) {
      throw new ForbiddenException('You can only access your own orders');
    }
    return this.orders.listForUser(userId, status);
  }
}
