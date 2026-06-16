import { PaymentMethod } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsArray, IsEnum, IsInt, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';

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

  // Customer-selected payment method. Optional for backward compatibility;
  // defaults to COD when omitted. Persisted to both Order.paymentMethod and
  // Payment.method so the two never diverge.
  @IsOptional()
  @IsEnum(PaymentMethod)
  payment_method?: PaymentMethod;

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
  voucher_code?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CheckoutItemDto)
  items!: CheckoutItemDto[];
}
