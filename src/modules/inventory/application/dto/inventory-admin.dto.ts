import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { StockTransferStatus } from '@prisma/client';
import { PaginationQueryDto } from '../../../../common/pagination/pagination';

export class CreateTransferDto {
  @IsString()
  productId!: string;

  @IsString()
  fromOutletId!: string;

  @IsString()
  toOutletId!: string;

  @IsInt()
  @Min(1)
  quantity!: number;

  @IsOptional()
  @IsString()
  note?: string;
}

export class AdjustStockDto {
  @IsString()
  productId!: string;

  @IsString()
  outletId!: string;

  /** New absolute stock value at this outlet. */
  @IsInt()
  @Min(0)
  stock!: number;

  @IsOptional()
  @IsString()
  note?: string;
}

export class ListInventoryQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  productId?: string;

  @IsOptional()
  @IsString()
  outletId?: string;

  @IsOptional()
  @IsString()
  search?: string;
}

export class ListTransfersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(StockTransferStatus)
  status?: StockTransferStatus;
}
