import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { CoverageType, OrderStatus, PaymentMethod, PaymentStatus, Prisma, Product, Promo, Topping, VoucherType } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { IdempotencyService, SupersededError } from '../../infrastructure/idempotency/idempotency.service';
import { PaymentUploadTokenService } from '../payments/payment-upload-token.service';
import { PaymentUniqueCodeService } from '../payments/payment-unique-code.service';
import { ShippingService } from '../shipping/shipping.service';
import { ShippingQuote, ShippingRateRequest } from '../shipping/domain/shipping-provider.interface';
import { DeliveryCoverageService } from '../delivery-coverage/delivery-coverage.service';
import { InventoryReservationService } from '../inventory/inventory-reservation.service';
import { InventoryAllocationService } from '../inventory/inventory-allocation.service';
import {
  CheckoutItemDto,
  CheckoutSummaryDto,
  CreateOrderDto,
  ShippingCostDto,
  ShippingOptionsDto,
  ValidateVoucherDto,
} from './application/dto/create-order.dto';
import { generateOrderNumber, isOrderNumberConflict } from './order-number.util';
import { buildOutboxEvent } from '../../infrastructure/outbox/outbox-event.builder';
import { PaymentInitiationService } from '../payments/gateway/payment-initiation.service';
import { PaymentChannelRegistry } from '../payments/gateway/payment-channel.registry';
import { buildCheckoutGatewayPayload } from '../payments/gateway/domain/payment-instruction.builder';
import { DEFAULT_PAYMENT_METHOD, isSelectablePaymentMethod, selectablePaymentMethods } from '../payments/gateway/domain/payment-channel';

type NormalizedCheckoutItem = {
  productId: string;
  quantity: number;
  toppingIds: string[];
  spicyLevel?: number;
  notes?: string;
};

type PersistOrderArgs = {
  userId: string;
  dto: CreateOrderDto;
  items: NormalizedCheckoutItem[];
  products: Product[];
  toppings: Topping[];
  summary: Awaited<ReturnType<OrdersService['getSummary']>>;
  idempotencyRecordId: string | null;
  fenceToken: number | null;
};

export interface IdempotencyRequest {
  key: string;
  method: string;
  endpoint: string;
}

export type CheckoutOutcome =
  | { kind: 'result'; statusCode: number; replayed: boolean; body: unknown }
  | { kind: 'processing'; retryAfterSeconds: number };

// Shared so the order.create response and a rehydrated replay return the
// identical shape (single source of truth for the checkout order include).
const ORDER_CHECKOUT_INCLUDE = {
  items: { include: { toppings: true } },
  payment: true,
} satisfies Prisma.OrderInclude;

@Injectable()
export class OrdersService {
  private readonly logger = new Logger('OrdersService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly shipping: ShippingService,
    private readonly idempotency: IdempotencyService,
    private readonly uploadTokens: PaymentUploadTokenService,
    // Optional so existing unit tests that construct OrdersService with 4 args keep
    // working; when absent (tests), coverage enforcement is skipped (legacy flow).
    @Optional() private readonly coverage?: DeliveryCoverageService,
    // Optional: when present, checkout RESERVES stock (committed at payment verify)
    // instead of decrementing Product.stock immediately (legacy fallback).
    @Optional() private readonly inventory?: InventoryReservationService,
    // Optional: when present, checkout ALLOCATES the best outlet (multi-outlet)
    // instead of always using the single active outlet (legacy fallback).
    @Optional() private readonly allocation?: InventoryAllocationService,
    // Optional: when present (and enabled), manual BANK_TRANSFER orders get a random
    // unique code folded into the amount. Absent → legacy behavior (no code).
    @Optional() private readonly uniqueCode?: PaymentUniqueCodeService,
    // Optional: opens the gateway charge AFTER the checkout transaction commits.
    // Absent (tests / gateway module removed) → checkout behaves exactly as before.
    @Optional() private readonly paymentInitiation?: PaymentInitiationService,
    @Optional() private readonly paymentChannels?: PaymentChannelRegistry,
  ) {}

  /**
   * Coverage gate for delivery. Delivery Coverage is ONLY responsible for the
   * DELIVERY / PICKUP_ONLY / DISABLED decision — it no longer calculates shipping
   * cost (that comes from the shipping providers). Throws for DISABLED / PICKUP_ONLY,
   * returns the coverageId to snapshot for DELIVERY, or null when unconfigured
   * (or the address predates the region hierarchy) → delivery is allowed.
   */
  private async resolveCoverage(address: {
    provinceId: string | null;
    cityId: string | null;
    districtId: string | null;
    villageId: string | null;
  }): Promise<{ coverageId: string } | null> {
    if (!this.coverage || !address.provinceId || !address.cityId) return null;
    const match = await this.coverage.resolve({
      provinceId: address.provinceId,
      cityId: address.cityId,
      districtId: address.districtId,
      villageId: address.villageId,
    });
    if (!match) return null;
    if (match.coverageType === CoverageType.DISABLED) {
      throw new BadRequestException('Sorry, we do not currently deliver to your location.');
    }
    if (match.coverageType === CoverageType.PICKUP_ONLY) {
      throw new BadRequestException('This area is only available for Pickup.');
    }
    return { coverageId: match.id };
  }

  /**
   * Resolve the shipping quote for the order. Uses the customer's explicit
   * provider+service selection when present; otherwise falls back to the chosen
   * courier's first service (legacy). The price is always taken server-side.
   */
  private async resolveShippingQuote(
    dto: { courier: string; shipping_provider?: string; shipping_service?: string },
    request: ShippingRateRequest,
  ): Promise<ShippingQuote> {
    if (dto.shipping_provider && dto.shipping_service) {
      return this.shipping.findQuote(request, dto.shipping_provider, dto.shipping_service);
    }
    const rate = await this.shipping.calculateRateForCourier(dto.courier, request);
    return {
      provider: rate.provider ?? dto.courier,
      service: rate.service,
      serviceName: `${rate.provider ?? dto.courier} ${rate.service ?? ''}`.trim(),
      estimatedDays: rate.etd,
      shippingCost: rate.cost,
    };
  }

  /**
   * Build a REAL shipping request: origin = the active outlet (System Settings),
   * destination = the customer's selected address. Validates that the destination
   * carries the required fields (postal code / province / city) and throws a
   * validation error otherwise — no placeholder values ever reach the providers.
   */
  private async buildShippingRequest(
    address: {
      provinceId: string | null;
      cityId: string | null;
      postalCode: string | null;
      latitude: unknown;
      longitude: unknown;
    },
    weightGram: number,
  ): Promise<ShippingRateRequest> {
    const missing: string[] = [];
    if (!address.postalCode) missing.push('postal code');
    if (!address.provinceId) missing.push('province');
    if (!address.cityId) missing.push('city');
    if (missing.length) {
      throw new BadRequestException(
        `Delivery address is missing required fields for shipping: ${missing.join(', ')}. Please update your address.`,
      );
    }

    const outlet = await this.prisma.outlet.findFirst({ where: { isActive: true } });
    const toNum = (v: unknown): number | undefined =>
      v === null || v === undefined ? undefined : Number(v);

    return {
      originPostalCode: outlet?.postalCode ?? '',
      destinationPostalCode: address.postalCode as string,
      weightGram,
      originLatitude: toNum(outlet?.latitude),
      originLongitude: toNum(outlet?.longitude),
      destinationLatitude: toNum(address.latitude),
      destinationLongitude: toNum(address.longitude),
      originName: outlet?.name,
    };
  }

  /**
   * Resolve the fulfilment outlet + shipping request + quotes. When the allocation
   * engine is wired it picks the best outlet (stock/distance/shipping/ETA);
   * otherwise it falls back to the single active outlet (legacy).
   */
  private async resolveOutletRequest(
    address: {
      provinceId: string | null;
      cityId: string | null;
      districtId: string | null;
      villageId: string | null;
      postalCode: string | null;
      latitude: unknown;
      longitude: unknown;
    },
    items: NormalizedCheckoutItem[],
    weightGram: number,
  ): Promise<{ outletId: string | null; request: ShippingRateRequest; quotes: ShippingQuote[] | null }> {
    if (this.allocation) {
      const allocItems = items.map((i) => ({ productId: i.productId, quantity: i.quantity }));
      const result = await this.allocation.allocate(allocItems, address, weightGram);
      const outlet = result.outlet;
      const request: ShippingRateRequest = {
        originPostalCode: outlet?.postalCode ?? '',
        destinationPostalCode: address.postalCode as string,
        weightGram,
        originLatitude: outlet?.latitude ?? undefined,
        originLongitude: outlet?.longitude ?? undefined,
        destinationLatitude: this.toNumOpt(address.latitude),
        destinationLongitude: this.toNumOpt(address.longitude),
        originName: outlet?.name,
      };
      return { outletId: result.outletId, request, quotes: result.quotes };
    }
    const request = await this.buildShippingRequest(address, weightGram);
    return { outletId: null, request, quotes: null };
  }

  private toNumOpt(v: unknown): number | undefined {
    return v === null || v === undefined ? undefined : Number(v);
  }

  /** Shipping services available for a cart + address (after the coverage gate). */
  async getShippingOptions(userId: string, dto: ShippingOptionsDto): Promise<ShippingQuote[]> {
    const address = await this.assertAddress(userId, dto.address_id);
    const items = this.normalizeItems(dto.items);
    const { totalItems } = await this.getCartPricing(items);
    // Gate: throws for DISABLED / PICKUP_ONLY so unsupported areas never see options.
    await this.resolveCoverage(address);
    const { request, quotes } = await this.resolveOutletRequest(address, items, this.getShippingWeightGram(totalItems));
    // Allocation already priced the chosen outlet; legacy path quotes on demand.
    return quotes ?? this.shipping.getQuotes(request);
  }

  private normalizeItems(items: CheckoutItemDto[]): NormalizedCheckoutItem[] {
    if (!items.length) throw new BadRequestException('Cart is empty');

    return items.map((item) => ({
      productId: item.product_id,
      quantity: item.qty,
      toppingIds: item.topping_ids ?? [],
      spicyLevel: item.spicyLevel,
      notes: item.notes,
    }));
  }

  private async findVoucherByCode(code: string) {
    const voucher = await this.prisma.promo.findFirst({ where: { code, deletedAt: null } });
    if (!voucher) throw new BadRequestException('Voucher code not found');
    return voucher;
  }

  private async assertVoucherAvailability(voucher: Promo, userId: string, subtotal: number) {
    const now = new Date();

    if (!voucher.isActive) {
      throw new BadRequestException('Voucher is not active');
    }

    if (voucher.startDate && now < voucher.startDate) {
      throw new BadRequestException('Voucher is not valid yet');
    }

    if (voucher.endDate && now > voucher.endDate) {
      throw new BadRequestException('Voucher has expired');
    }

    if (voucher.maxUsageCount !== null && voucher.currentUsageCount >= voucher.maxUsageCount) {
      throw new BadRequestException('Voucher usage limit has been reached');
    }

    if (voucher.minimumOrderAmount > 0 && subtotal < voucher.minimumOrderAmount) {
      throw new BadRequestException(`Minimum order amount is Rp ${voucher.minimumOrderAmount.toLocaleString('id-ID')}`);
    }

    if (voucher.isNewUserOnly) {
      const completedOrders = await this.prisma.order.count({
        where: { userId, status: OrderStatus.COMPLETED, deletedAt: null },
      });
      if (completedOrders > 0) {
        throw new BadRequestException('Voucher is only available for new customers');
      }
    }

    const existingUsage = await this.prisma.voucherUsage.findFirst({
      where: { voucherId: voucher.id, userId },
    });
    if (existingUsage) {
      throw new BadRequestException('This voucher has already been used by your account');
    }

    if (voucher.voucherType === VoucherType.FREE_SHIPPING && voucher.freeShippingMaxAmount !== null && voucher.freeShippingMaxAmount < 0) {
      throw new BadRequestException('Voucher shipping limit is invalid');
    }

    if (voucher.voucherType === VoucherType.PERCENTAGE_DISCOUNT && !voucher.discountPercentage) {
      throw new BadRequestException('Voucher configuration is invalid');
    }

    if (voucher.voucherType === VoucherType.FIXED_DISCOUNT && (!voucher.discountAmount || voucher.discountAmount <= 0)) {
      throw new BadRequestException('Voucher configuration is invalid');
    }
  }

  private calculateVoucherDiscount(voucher: Promo, subtotal: number, shippingCost: number) {
    switch (voucher.voucherType) {
      case VoucherType.FREE_SHIPPING: {
        if (shippingCost === 0) {
          return 0;
        }
        const maxAmount = voucher.freeShippingMaxAmount ?? shippingCost;
        return Math.min(shippingCost, maxAmount);
      }
      case VoucherType.PERCENTAGE_DISCOUNT: {
        const discount = Math.floor((subtotal * (voucher.discountPercentage ?? 0)) / 100);
        if (voucher.maxDiscountAmount !== null && voucher.maxDiscountAmount !== undefined) {
          return Math.min(discount, voucher.maxDiscountAmount);
        }
        return discount;
      }
      case VoucherType.FIXED_DISCOUNT: {
        return Math.min(voucher.discountAmount ?? 0, subtotal);
      }
      default:
        return 0;
    }
  }

  private async assertAddress(userId: string, addressId: string) {
    const address = await this.prisma.address.findFirst({
      where: { id: addressId, userId, deletedAt: null },
    });
    if (!address) throw new BadRequestException('Shipping address is invalid');
    return address;
  }

  private async getCartPricing(items: NormalizedCheckoutItem[]) {
    const productIds = [...new Set(items.map((item) => item.productId))];
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds }, deletedAt: null, status: 'ACTIVE' },
    });
    if (products.length !== productIds.length) throw new BadRequestException('Some products are unavailable');

    const toppingIds = [...new Set(items.flatMap((item) => item.toppingIds))];
    const toppings = toppingIds.length
      ? await this.prisma.topping.findMany({ where: { id: { in: toppingIds }, deletedAt: null, isActive: true } })
      : [];
    if (toppings.length !== toppingIds.length) throw new BadRequestException('Some toppings are unavailable');

    const subtotal = items.reduce((sum, item) => {
      const product = products.find((candidate) => candidate.id === item.productId)!;
      const toppingTotal = item.toppingIds.reduce((inner, id) => inner + (toppings.find((topping) => topping.id === id)?.price ?? 0), 0);
      return sum + (product.price + toppingTotal) * item.quantity;
    }, 0);

    const totalItems = items.reduce((sum, item) => sum + item.quantity, 0);

    return { products, toppings, subtotal, totalItems };
  }

  private assertStock(items: NormalizedCheckoutItem[], products: Product[]) {
    for (const product of products) {
      const requestedQty = items
        .filter((item) => item.productId === product.id)
        .reduce((sum, item) => sum + item.quantity, 0);

      if (requestedQty > product.stock) {
        throw new BadRequestException(`Insufficient stock for ${product.name}`);
      }
    }
  }

  private getShippingWeightGram(totalItems: number) {
    return Math.max(1, totalItems) * 500;
  }

  private normalizeEstimatedDays(etd: string) {
    return etd.replace(/\s*days?\s*$/i, '');
  }

  async calculateShippingCost(userId: string, dto: ShippingCostDto) {
    const address = await this.assertAddress(userId, dto.address_id);
    const items = this.normalizeItems(dto.items);
    const { totalItems } = await this.getCartPricing(items);
    const request = await this.buildShippingRequest(address, this.getShippingWeightGram(totalItems));
    const rate = await this.shipping.calculateRateForCourier(dto.courier, request);

    return {
      shipping_cost: rate.cost,
      estimated_days: this.normalizeEstimatedDays(rate.etd),
    };
  }

  async previewVoucher(userId: string, dto: ValidateVoucherDto) {
    try {
      const voucher = await this.findVoucherByCode(dto.voucher_code.trim().toUpperCase());
      await this.assertVoucherAvailability(voucher, userId, dto.subtotal);
      const discount = this.calculateVoucherDiscount(voucher, dto.subtotal, 0);

      return {
        valid: true,
        discount,
        voucher_type: voucher.voucherType,
      };
    } catch (error) {
      return {
        valid: false,
        discount: 0,
        voucher_type: null,
        message: error instanceof BadRequestException ? error.message : 'Voucher is invalid',
      };
    }
  }

  async getSummary(userId: string, dto: CheckoutSummaryDto) {
    const address = await this.assertAddress(userId, dto.address_id);
    const items = this.normalizeItems(dto.items);
    const { products, subtotal, totalItems } = await this.getCartPricing(items);
    this.assertStock(items, products);

    // Coverage gate only (DISABLED / PICKUP_ONLY throw); it no longer sets the fee.
    const coverage = await this.resolveCoverage(address);

    // Allocate the best outlet (multi-outlet) or fall back to the active outlet;
    // shipping is priced from that outlet's origin.
    const { outletId, request } = await this.resolveOutletRequest(address, items, this.getShippingWeightGram(totalItems));
    const quote = await this.resolveShippingQuote(dto, request);
    const deliveryFee = quote.shippingCost;

    let voucher: Promo | null = null;
    let discount = 0;

    if (dto.voucher_code) {
      voucher = await this.findVoucherByCode(dto.voucher_code.trim().toUpperCase());
      await this.assertVoucherAvailability(voucher, userId, subtotal);
      discount = this.calculateVoucherDiscount(voucher, subtotal, deliveryFee);
    }

    return {
      subtotal,
      shipping_cost: deliveryFee,
      delivery_fee: deliveryFee,
      discount,
      grand_total: subtotal + deliveryFee - discount,
      total_items: totalItems,
      estimated_days: quote.estimatedDays,
      estimated_minutes: null as number | null,
      coverage_id: coverage?.coverageId ?? null,
      outlet_id: outletId,
      shipping: quote,
      voucher,
    };
  }

  async checkout(userId: string, dto: CreateOrderDto, idem?: IdempotencyRequest): Promise<CheckoutOutcome> {
    // Phase A: idempotency is opt-in (key present) and flag-gated. Without it,
    // checkout behaves exactly as before.
    if (!idem || !this.idempotency.isCheckoutEnabled()) {
      const order = await this.runCheckout(userId, dto, null, null);
      return { kind: 'result', statusCode: 201, replayed: false, body: order };
    }

    const begin = await this.idempotency.begin({
      userId,
      key: idem.key,
      method: idem.method,
      endpoint: idem.endpoint,
      fingerprintInput: this.buildFingerprintInput(userId, idem, dto),
    });

    if (begin.kind === 'replay') {
      return { kind: 'result', statusCode: begin.statusCode, replayed: true, body: await this.resolveReplayBody(begin) };
    }
    if (begin.kind === 'processing') {
      return { kind: 'processing', retryAfterSeconds: this.idempotency.retryAfterSeconds() };
    }

    try {
      const order = await this.runCheckout(userId, dto, begin.record.id, begin.record.fenceToken);
      return { kind: 'result', statusCode: 201, replayed: false, body: order };
    } catch (err) {
      // Ownership lost mid-flight (a reclaimer superseded us): the order tx already
      // rolled back. Never surface a raw 500 — replay the winner or signal 409.
      if (err instanceof SupersededError) {
        const resolved = await this.idempotency.resolveAfterSupersession(userId, idem.key);
        return resolved.kind === 'replay'
          ? { kind: 'result', statusCode: resolved.statusCode, replayed: true, body: await this.resolveReplayBody(resolved) }
          : { kind: 'processing', retryAfterSeconds: this.idempotency.retryAfterSeconds() };
      }
      await this.idempotency.markFailed(begin.record.id, begin.record.fenceToken, err);
      throw err;
    }
  }

  /**
   * Resolve the body for a COMPLETED replay. In 'snapshot' mode (default) returns
   * the stored response verbatim. In 'rehydrate' mode re-reads the Order by
   * resourceId — same include as creation, so the shape is identical — returning
   * current order/payment state. Falls back to the stored snapshot if the order
   * is gone, so a previously-successful checkout never 404s.
   */
  private async resolveReplayBody(replay: {
    body: Prisma.JsonValue;
    resourceType: string | null;
    resourceId: string | null;
  }) {
    if (this.idempotency.replayMode() !== 'rehydrate') {
      return replay.body;
    }
    if (replay.resourceType !== 'Order' || !replay.resourceId) {
      return replay.body;
    }
    const order = await this.prisma.order.findUnique({
      where: { id: replay.resourceId },
      include: ORDER_CHECKOUT_INCLUDE,
    });
    return order ?? replay.body;
  }

  /** Canonical projection of the checkout request that is hashed into the fingerprint. */
  private buildFingerprintInput(userId: string, idem: IdempotencyRequest, dto: CreateOrderDto) {
    const items = (dto.items ?? [])
      .map((item) => ({
        product_id: item.product_id,
        qty: item.qty,
        spicyLevel: item.spicyLevel ?? null,
        notes: item.notes ?? null,
        topping_ids: [...(item.topping_ids ?? [])].sort(),
      }))
      .sort(
        (a, b) =>
          a.product_id.localeCompare(b.product_id) ||
          a.topping_ids.join(',').localeCompare(b.topping_ids.join(',')) ||
          (a.spicyLevel ?? -1) - (b.spicyLevel ?? -1) ||
          String(a.notes).localeCompare(String(b.notes)),
      );
    return {
      userId,
      method: idem.method,
      endpoint: idem.endpoint,
      body: {
        address_id: dto.address_id,
        courier: dto.courier,
        voucher_code: dto.voucher_code ? dto.voucher_code.trim().toUpperCase() : null,
        items,
      },
    };
  }

  private async runCheckout(
    userId: string,
    dto: CreateOrderDto,
    idempotencyRecordId: string | null,
    fenceToken: number | null,
  ) {
    this.assertSelectablePaymentMethod(dto.payment_method);
    const items = this.normalizeItems(dto.items);
    const { products, toppings } = await this.getCartPricing(items);
    this.assertStock(items, products);
    const summary = await this.getSummary(userId, dto);

    const order = await this.persistOrderWithRetry({ userId, dto, items, products, toppings, summary, idempotencyRecordId, fenceToken });
    return this.withGatewayCharge(order, dto);
  }

  /**
   * The ONLY gate on which payment methods may start a new order. Selectability
   * is derived from the payment-channel registry (Phase 4A), so COD — offered by
   * no channel — can never be created again. Historical COD orders are read-only
   * data and are entirely unaffected.
   */
  private assertSelectablePaymentMethod(method?: PaymentMethod): void {
    if (!method) return; // omitted → DEFAULT_PAYMENT_METHOD, which is selectable by construction
    if (!isSelectablePaymentMethod(method)) {
      throw new BadRequestException(
        `Payment method ${method} is no longer available. Choose one of: ${selectablePaymentMethods().join(', ')}.`,
      );
    }
  }

  /**
   * GATEWAY orders open their charge AFTER the checkout transaction has committed
   * — an external HTTP call must never run inside a database transaction (the
   * same rule the post-verify shipment booking follows).
   *
   * Best-effort by design: if the gateway is unreachable the ORDER STILL STANDS
   * with a PENDING payment, exactly as a manual order would; the customer can be
   * offered the payment page again. Non-gateway methods return untouched, so the
   * manual flow is byte-identical.
   */
  private async withGatewayCharge(order: Awaited<ReturnType<OrdersService['persistOrderOnce']>>, dto: CreateOrderDto) {
    const method = dto.payment_method ?? DEFAULT_PAYMENT_METHOD;
    if (method !== PaymentMethod.GATEWAY) return order;
    if (!dto.payment_channel || !this.paymentInitiation || !this.paymentChannels) return order;

    const descriptor = this.paymentChannels.find(dto.payment_channel);
    if (!descriptor) return order;

    try {
      const result = await this.paymentInitiation.initiate(order.payment!.id, dto.payment_channel);
      // Additive block: every existing field of the order response is untouched.
      return { ...order, ...buildCheckoutGatewayPayload(result, descriptor) };
    } catch (err) {
      this.logger.error(
        `gateway charge failed for order ${order.orderNumber}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return order; // order survives; payment stays PENDING
    }
  }

  // Retry the order transaction on the astronomically-rare orderNumber unique
  // violation (P2002), regenerating the random suffix each attempt.
  private async persistOrderWithRetry(args: PersistOrderArgs) {
    const MAX_ORDER_NUMBER_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ORDER_NUMBER_ATTEMPTS; attempt += 1) {
      try {
        return await this.persistOrderOnce(generateOrderNumber(), args);
      } catch (err) {
        if (attempt < MAX_ORDER_NUMBER_ATTEMPTS && isOrderNumberConflict(err)) {
          continue;
        }
        throw err;
      }
    }
    throw new Error('Failed to allocate a unique order number');
  }

  private async persistOrderOnce(orderNumber: string, args: PersistOrderArgs) {
    const { userId, dto, items, products, toppings, summary, idempotencyRecordId, fenceToken } = args;
    const voucher = summary.voucher;
    // Single source of truth for the method: persisted identically to the order
    // and its payment. Defaults to manual bank transfer when the client omits a
    // selection (Phase 4A — COD is no longer selectable).
    const paymentMethod = dto.payment_method ?? DEFAULT_PAYMENT_METHOD;

    // Accounting split: the unique code is NOT business revenue — it only identifies
    // the bank transfer. So the business total (subtotal + shipping - discount) is
    // stored on Order.totalPrice (what reports sum), while the transfer total
    // (businessTotal + uniqueCode) is stored on Payment.amount (what the customer
    // sends). Only BANK_TRANSFER gets a code; when it is null (QRIS/COD/legacy/disabled)
    // transferTotal == businessTotal, so Payment.amount == Order.totalPrice.
    const businessTotal = summary.grand_total;

    const order = await this.prisma.$transaction(async (tx) => {
      // C4: unique-code allocation runs INSIDE the checkout transaction, so the
      // collision re-check against PENDING transfers happens immediately before
      // the payment row is created (a pre-tx probe could race a concurrent
      // checkout committing the same transfer total between check and create).
      let uniqueCode: number | null = null;
      let transferTotal = businessTotal;
      if (paymentMethod === PaymentMethod.BANK_TRANSFER && this.uniqueCode?.isEnabled()) {
        uniqueCode = await this.uniqueCode.allocateInTx(tx, businessTotal);
        if (uniqueCode !== null) transferTotal = businessTotal + uniqueCode;
      }
      // Legacy path (no inventory service wired): decrement Product.stock now.
      // Reservation path (inventory present): stock is RESERVED after order.create
      // below and only deducted at payment verification.
      if (!this.inventory) {
        for (const product of products) {
          const requestedQty = items
            .filter((item) => item.productId === product.id)
            .reduce((sum, item) => sum + item.quantity, 0);

          const stockUpdate = await tx.product.updateMany({
            where: { id: product.id, stock: { gte: requestedQty } },
            data: { stock: { decrement: requestedQty } },
          });

          if (stockUpdate.count !== 1) {
            throw new BadRequestException(`Insufficient stock for ${product.name}`);
          }
        }
      }

      const createdOrder = await tx.order.create({
        data: {
          orderNumber,
          userId,
          addressId: dto.address_id,
          paymentMethod,
          subtotal: summary.subtotal,
          deliveryFee: summary.shipping_cost,
          voucherDiscountAmount: summary.discount,
          // Business revenue only — the unique code lives on Payment.amount, not here.
          totalPrice: businessTotal,
          coverageId: summary.coverage_id ?? undefined,
          estimatedDeliveryMinutes: summary.estimated_minutes ?? undefined,
          outletId: summary.outlet_id ?? undefined,
          // Shipping-provider quote snapshot (for order history + admin display).
          shippingProvider: summary.shipping.provider,
          shippingService: summary.shipping.service,
          shippingServiceName: summary.shipping.serviceName,
          shippingCost: summary.shipping.shippingCost,
          shippingPayload: JSON.parse(JSON.stringify(summary.shipping)) as Prisma.InputJsonValue,
          voucherId: voucher?.id,
          voucherCode: voucher?.code,
          voucherType: voucher?.voucherType,
          items: {
            create: items.map((item) => {
              const product = products.find((p) => p.id === item.productId)!;
              return {
                productId: product.id,
                productName: product.name,
                unitPrice: product.price,
                quantity: item.quantity,
                spicyLevel: item.spicyLevel,
                notes: item.notes,
                toppings: {
                  create: item.toppingIds.map((id) => {
                    const topping = toppings.find((t) => t.id === id)!;
                    return { toppingId: id, name: topping.name, price: topping.price };
                  }),
                },
              };
            }),
          },
          payment: {
            create: {
              method: paymentMethod,
              // Transfer total = businessTotal + uniqueCode (what the customer sends).
              amount: transferTotal,
              uniqueCode,
              status: PaymentStatus.PENDING,
            },
          },
          shipment: {
            create: {
              provider: summary.shipping.provider ?? dto.courier,
              service: summary.shipping.serviceName || summary.shipping.service || dto.courier,
              status: 'RATE_SELECTED',
              cost: summary.shipping_cost,
              metadata: {
                estimatedDays: summary.estimated_days ?? null,
                provider: summary.shipping.provider ?? dto.courier,
                service: summary.shipping.service ?? null,
                serviceName: summary.shipping.serviceName ?? null,
              },
            },
          },
          events: {
            create: {
              status: OrderStatus.PENDING,
              note: 'Order created',
            },
          },
        },
        include: ORDER_CHECKOUT_INCLUDE,
      });

      // Reserve stock for every item (row-locked availability check). Any shortfall
      // throws → the whole checkout transaction (order, payment, …) rolls back.
      if (this.inventory) {
        await this.inventory.reserveForOrder(tx, {
          orderId: createdOrder.id,
          items: items.map((item) => ({ productId: item.productId, quantity: item.quantity })),
          paymentMethod,
          outletId: summary.outlet_id ?? undefined,
        });
      }

      if (voucher) {
        const voucherUpdate = voucher.maxUsageCount !== null
          ? tx.promo.update({
              where: { id: voucher.id, currentUsageCount: { lt: voucher.maxUsageCount } },
              data: { currentUsageCount: { increment: 1 } },
            })
          : tx.promo.update({ where: { id: voucher.id }, data: { currentUsageCount: { increment: 1 } } });

        await voucherUpdate;

        await tx.voucherUsage.create({
          data: {
            voucherId: voucher.id,
            userId,
            orderId: createdOrder.id,
          },
        });
      }

      // Finalize the idempotency key in the SAME transaction as the order, so the
      // COMPLETED record and its replayable response commit atomically with the order.
      // Fenced: if we were superseded by a reclaimer, finalize throws SupersededError
      // and this whole transaction (order, stock, voucher) rolls back.
      if (idempotencyRecordId) {
        await this.idempotency.finalize(tx, idempotencyRecordId, fenceToken!, {
          statusCode: 201,
          body: JSON.parse(JSON.stringify(createdOrder)) as Prisma.InputJsonValue,
          resourceType: 'Order',
          resourceId: createdOrder.id,
        });
      }

      // For non-COD methods, issue a single-use upload token in the SAME tx so the
      // customer can submit a receipt via a link without logging in. The upload URL
      // rides along in order.created so the notification can include it. COD has no
      // receipt step, so no token is issued.
      let uploadUrl: string | undefined;
      if (paymentMethod === PaymentMethod.BANK_TRANSFER || paymentMethod === PaymentMethod.QRIS) {
        const issued = await this.uploadTokens.issue(tx, createdOrder.payment!.id);
        uploadUrl = issued.uploadUrl;
      }

      // Emit order.created via the transactional outbox, in the SAME transaction as
      // the order. It is the last statement so a superseded finalize (above) rolls
      // back the order AND this event together — no event for an uncommitted order.
      await tx.outboxEvent.create({
        data: buildOutboxEvent({
          aggregateType: 'order',
          aggregateId: createdOrder.id,
          eventName: 'order.created',
          exchange: 'orders',
          routingKey: 'order.created',
          payload: {
            orderId: createdOrder.id,
            orderNumber: createdOrder.orderNumber,
            // Notifications show the amount the customer must transfer = Payment.amount
            // (transfer total). Order.totalPrice is now business-only, so source this
            // from the payment to keep the customer-facing amount unchanged.
            totalPrice: createdOrder.payment!.amount,
            ...(uploadUrl ? { uploadUrl } : {}),
          },
          metadata: { source: 'orders.checkout' },
        }),
      });

      return createdOrder;
    });

    return order;
  }

  /**
   * The customer's own orders.
   *
   * `payment` keeps every field it returned before (`include` selects all Payment
   * scalars), plus ONE additive summary: `payment.gateway`, the latest gateway
   * attempt's deadline and state. The storefront needs it to stop offering "Bayar
   * Sekarang" for an attempt that already died — Payment.status stays PENDING
   * until the provider's expire notification arrives, which can lag by hours.
   *
   * Deliberately a NARROW `select`: this is a list endpoint, so anything exposed
   * here is multiplied across every order. The QR payload, VA number, provider
   * ids and raw provider bodies stay out, as does the provider NAME — customers
   * never see which gateway is in use.
   *
   * One batched query, no N+1: the nested read is index-backed by
   * `@@index([paymentId, createdAt])`.
   */
  async listForUser(userId: string, status?: string) {
    const orders = await this.prisma.order.findMany({
      where: { userId, deletedAt: null, status: status as never },
      include: {
        items: { include: { toppings: true } },
        address: true,
        payment: {
          include: {
            gatewayTransactions: {
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: { expiryAt: true, status: true },
            },
          },
        },
        shipment: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    // Present the latest attempt as `payment.gateway`; the relation name and its
    // array shape are an internal detail the frontend should not depend on.
    return orders.map(({ payment, ...order }) => {
      if (!payment) return { ...order, payment: null };
      const { gatewayTransactions, ...rest } = payment;
      const latest = gatewayTransactions[0];
      // Rebuild the summary field by field rather than spreading the row: the
      // narrow `select` above already limits it, but widening that clause later
      // must not silently start publishing provider data to every order.
      const gateway = latest ? { expiryAt: latest.expiryAt, status: latest.status } : null;
      return { ...order, payment: { ...rest, gateway } };
    });
  }
}
