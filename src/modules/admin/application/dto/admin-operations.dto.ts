import { IsEnum, IsInt, IsObject, IsOptional, IsString, IsUrl, Min } from 'class-validator';
import { OrderStatus, PaymentStatus, ShipmentStatus } from '@prisma/client';

export class ListAdminOrdersQueryDto {
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  @IsOptional()
  @IsEnum(PaymentStatus)
  paymentStatus?: PaymentStatus;
}

export class UpdateOrderStatusDto {
  @IsEnum(OrderStatus)
  status!: OrderStatus;

  @IsOptional()
  @IsString()
  note?: string;
}

export class VerifyAdminPaymentDto {
  @IsOptional()
  @IsString()
  note?: string;
}

export class RejectAdminPaymentDto {
  @IsOptional()
  @IsString()
  note?: string;
}

export class CreateShipmentDto {
  @IsString()
  orderId!: string;

  @IsString()
  provider!: string;

  @IsString()
  service!: string;

  @IsInt()
  @Min(0)
  cost!: number;

  @IsOptional()
  @IsEnum(ShipmentStatus)
  status?: ShipmentStatus;

  @IsOptional()
  @IsString()
  trackingNumber?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  trackingUrl?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class UpdateShipmentDto {
  @IsOptional()
  @IsString()
  provider?: string;

  @IsOptional()
  @IsString()
  service?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  cost?: number;

  @IsOptional()
  @IsEnum(ShipmentStatus)
  status?: ShipmentStatus;

  @IsOptional()
  @IsString()
  trackingNumber?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  trackingUrl?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class ListAdminShipmentsQueryDto {
  @IsOptional()
  @IsEnum(ShipmentStatus)
  status?: ShipmentStatus;
}
