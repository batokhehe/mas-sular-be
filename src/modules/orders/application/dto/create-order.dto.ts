import { PaymentMethod } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsArray, IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';

export enum CheckoutCourier {
  PAXEL = 'paxel',
  JNE = 'jne',
}

export class CheckoutItemDto {
  @IsString()
  product_id!: string;

  @IsInt()
  @Min(1)
  qty!: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  topping_ids?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5)
  spicyLevel?: number;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class CreateOrderDto {
  @IsString()
  address_id!: string;

  @IsEnum(CheckoutCourier)
  courier!: CheckoutCourier;

  // Customer-selected shipping service (provider + service code) from the quotes
  // returned by /checkout/shipping-options. Optional for backward compatibility;
  // when omitted the courier's first service is used (legacy behavior).
  @IsOptional()
  @IsString()
  shipping_provider?: string;

  @IsOptional()
  @IsString()
  shipping_service?: string;

  // Customer-selected payment method. Optional for backward compatibility;
  // defaults to BANK_TRANSFER when omitted (Phase 4A — COD is no longer
  // selectable). Persisted to both Order.paymentMethod and
  // Payment.method so the two never diverge.
  @IsOptional()
  @IsEnum(PaymentMethod)
  payment_method?: PaymentMethod;

  /**
   * Customer-facing payment channel (QRIS, GOPAY, BCA_VA, …). Only meaningful for
   * PaymentMethod.GATEWAY; ignored otherwise. Optional so every existing client
   * — which sends only payment_method — keeps working unchanged.
   */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  payment_channel?: string;

  @IsOptional()
  @IsString()
  voucher_code?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CheckoutItemDto)
  items!: CheckoutItemDto[];
}

export class ValidateVoucherDto {
  @IsString()
  voucher_code!: string;

  @IsInt()
  @Min(0)
  subtotal!: number;
}

export class ShippingCostDto {
  @IsString()
  address_id!: string;

  @IsEnum(CheckoutCourier)
  courier!: CheckoutCourier;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CheckoutItemDto)
  items!: CheckoutItemDto[];
}

export class CheckoutSummaryDto {
  @IsString()
  address_id!: string;

  @IsEnum(CheckoutCourier)
  courier!: CheckoutCourier;

  @IsOptional()
  @IsString()
  shipping_provider?: string;

  @IsOptional()
  @IsString()
  shipping_service?: string;

  @IsOptional()
  @IsString()
  voucher_code?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CheckoutItemDto)
  items!: CheckoutItemDto[];
}

/** Request the available shipping services for a cart + address (after coverage). */
export class ShippingOptionsDto {
  @IsString()
  address_id!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CheckoutItemDto)
  items!: CheckoutItemDto[];
}
