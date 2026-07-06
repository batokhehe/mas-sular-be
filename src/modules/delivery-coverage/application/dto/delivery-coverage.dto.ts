import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { CoverageType } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class CreateDeliveryCoverageDto {
  @ApiProperty()
  @IsString()
  provinceId!: string;

  @ApiProperty()
  @IsString()
  cityId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  districtId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  villageId?: string;

  @ApiProperty({ enum: CoverageType })
  @IsEnum(CoverageType)
  coverageType!: CoverageType;

  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0, { message: 'Delivery fee must be >= 0' })
  deliveryFee?: number;

  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0, { message: 'Minimum order must be >= 0' })
  minimumOrder?: number;

  @ApiPropertyOptional({ minimum: 1, default: 60 })
  @IsOptional()
  @IsInt()
  @Min(1, { message: 'Estimated minutes must be > 0' })
  estimatedMinutes?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateDeliveryCoverageDto extends PartialType(CreateDeliveryCoverageDto) {}

/** Public coverage-check query (used by checkout). */
export class CheckCoverageQueryDto {
  @ApiProperty()
  @IsString()
  provinceId!: string;

  @ApiProperty()
  @IsString()
  cityId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  districtId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  villageId?: string;
}

/** Admin list filters. */
export class ListCoverageQueryDto {
  @ApiPropertyOptional({ description: 'Name/code contains filter across region levels' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ enum: CoverageType })
  @IsOptional()
  @IsEnum(CoverageType)
  coverageType?: CoverageType;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === '') return undefined;
    if (typeof value === 'boolean') return value;
    return value === 'true' || value === '1';
  })
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  provinceId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  cityId?: string;
}
