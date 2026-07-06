import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** Shared list controls for every master-address lookup (search / limit / isActive). */
class RegionListQueryDto {
  @ApiPropertyOptional({ description: 'Case-insensitive name/code contains filter' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 1000 })
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;

  @ApiPropertyOptional({ description: 'Filter by active flag; defaults to active-only', default: true })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === '') return undefined;
    if (typeof value === 'boolean') return value;
    return value === 'true' || value === '1';
  })
  @IsBoolean()
  isActive?: boolean;
}

export class ListProvincesQueryDto extends RegionListQueryDto {}

export class ListCitiesQueryDto extends RegionListQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  provinceId?: string;
}

export class ListDistrictsQueryDto extends RegionListQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  cityId?: string;
}

export class ListVillagesQueryDto extends RegionListQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  districtId?: string;
}
