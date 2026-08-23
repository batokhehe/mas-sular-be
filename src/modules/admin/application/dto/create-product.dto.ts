import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ProductStatus } from '@prisma/client';

export class CreateProductDto {
  @IsString()
  slug!: string;

  @IsString()
  sku!: string;

  @IsString()
  name!: string;

  @IsString()
  description!: string;

  @IsInt()
  @Min(0)
  price!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  originalPrice?: number;

  @IsString()
  imageUrl!: string;

  @IsOptional()
  @IsInt()
  spicyLevel?: number;

  @IsOptional()
  @IsBoolean()
  isBestSeller?: boolean;

  @IsOptional()
  @IsBoolean()
  isNew?: boolean;

  @IsEnum(ProductStatus)
  status!: ProductStatus;

  @IsInt()
  stock!: number;

  @IsString()
  categoryId!: string;

  // --- Physical attributes for courier booking -------------------------------
  // Optional so the existing catalogue stays valid; when supplied they must be
  // within Paxel's documented per-item bounds, because an out-of-range value is
  // rejected by the courier at booking time rather than at edit time.
  // Weight in grams (Paxel: between 1 and 5000).
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5000)
  weightGram?: number;

  // Dimensions in centimetres (Paxel: each side between 1 and 50).
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  lengthCm?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  widthCm?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  heightCm?: number;

  @IsOptional()
  @IsBoolean()
  isFragile?: boolean;

}
