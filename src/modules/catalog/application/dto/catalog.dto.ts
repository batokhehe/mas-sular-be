import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';

export class ListProductsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({ enum: ['popular', 'price-low', 'price-high', 'rating'] })
  @IsOptional()
  @IsIn(['popular', 'price-low', 'price-high', 'rating'])
  sort?: 'popular' | 'price-low' | 'price-high' | 'rating';
}
