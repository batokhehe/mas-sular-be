import { IsBoolean, IsDateString, IsEnum, IsInt, IsOptional, IsString, Max, Min, ValidateIf } from 'class-validator';
import { VoucherType } from '@prisma/client';

export class UpdatePromoDto {
  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  imageUrl?: string;

  @IsOptional()
  @IsEnum(VoucherType)
  voucherType?: VoucherType;

  @ValidateIf((dto) => dto.voucherType === VoucherType.PERCENTAGE_DISCOUNT)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  discountPercentage?: number;

  @ValidateIf((dto) => dto.voucherType === VoucherType.FIXED_DISCOUNT)
  @IsOptional()
  @IsInt()
  @Min(1)
  discountAmount?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  maxDiscountAmount?: number;

  @ValidateIf((dto) => dto.voucherType === VoucherType.FREE_SHIPPING)
  @IsOptional()
  @IsInt()
  @Min(0)
  freeShippingMaxAmount?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  minimumOrderAmount?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  maxUsageCount?: number;

  @IsOptional()
  @IsBoolean()
  isNewUserOnly?: boolean;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
