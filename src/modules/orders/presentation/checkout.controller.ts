import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Headers,
  Post,
  Res,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AuthUser, CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { IdempotencyService } from '../../../infrastructure/idempotency/idempotency.service';
import { CheckoutSummaryDto, CreateOrderDto, ShippingCostDto, ValidateVoucherDto } from '../application/dto/create-order.dto';
import { OrdersService } from '../orders.service';
import { CheckoutIdempotencyMetrics } from './checkout-idempotency.metrics';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._-]+$/;
const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

@ApiTags('checkout')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'checkout', version: '1' })
export class CheckoutController {
  constructor(
    private readonly orders: OrdersService,
    private readonly idempotency: IdempotencyService,
    private readonly metrics: CheckoutIdempotencyMetrics,
  ) {}

  @Post('shipping-cost')
  shippingCost(@CurrentUser() user: AuthUser, @Body() dto: ShippingCostDto) {
    return this.orders.calculateShippingCost(user.sub, dto);
  }

  @Post('validate-voucher')
  validateVoucher(@CurrentUser() user: AuthUser, @Body() dto: ValidateVoucherDto) {
    return this.orders.previewVoucher(user.sub, dto);
  }

  @Post('summary')
  summary(@CurrentUser() user: AuthUser, @Body() dto: CheckoutSummaryDto) {
    return this.orders.getSummary(user.sub, dto);
  }

  @Post('order')
  async createOrder(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateOrderDto,
    @Res({ passthrough: true }) res: Response,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const key = this.resolveIdempotencyKey(idempotencyKey);
    const idem = key ? { key, method: 'POST', endpoint: '/checkout/order' } : undefined;

    let outcome;
    try {
      outcome = await this.orders.checkout(user.sub, dto, idem);
    } catch (err) {
      // The only 422 in this flow is a reused key with a different request.
      if (err instanceof UnprocessableEntityException) {
        this.metrics.fingerprintMismatch();
      }
      throw err;
    }

    if (outcome.kind === 'processing') {
      this.metrics.processingConflict();
      res.setHeader('Retry-After', String(outcome.retryAfterSeconds));
      throw new ConflictException('Checkout already in progress for this Idempotency-Key');
    }

    if (outcome.replayed) {
      this.metrics.replay();
      res.setHeader('Idempotent-Replayed', 'true');
    }
    res.status(outcome.statusCode);
    return outcome.body;
  }

  /**
   * Validate the Idempotency-Key whenever it is present (closes A7), and enforce
   * its presence when CHECKOUT_IDEMPOTENCY_REQUIRED is on. Returns the validated
   * key, or undefined when absent and not required.
   */
  private resolveIdempotencyKey(raw?: string): string | undefined {
    if (raw === undefined) {
      if (this.idempotency.isCheckoutRequired()) {
        this.metrics.missingKey();
        throw new BadRequestException('Idempotency-Key header is required');
      }
      return undefined;
    }

    if (raw.trim() === '') {
      this.metrics.invalidKey('empty');
      throw new BadRequestException('Idempotency-Key must not be empty');
    }
    if (raw.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
      this.metrics.invalidKey('too_long');
      throw new BadRequestException(`Idempotency-Key must be at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`);
    }
    if (!IDEMPOTENCY_KEY_PATTERN.test(raw)) {
      this.metrics.invalidKey('charset');
      throw new BadRequestException('Idempotency-Key may only contain A-Z, a-z, 0-9, dot, underscore, and hyphen');
    }
    return raw;
  }
}
