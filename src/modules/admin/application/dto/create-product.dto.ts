import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';
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
}
