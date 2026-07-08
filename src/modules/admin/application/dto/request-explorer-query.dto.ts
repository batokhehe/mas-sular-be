import { Transform } from 'class-transformer';
import { IsDate, IsInt, IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from '../../../../common/pagination/pagination';

const toDate = (value: unknown): Date | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? undefined : d;
};
const toInt = (value: unknown): number | undefined =>
  value === undefined || value === '' ? undefined : Number(value);

export class ListRequestsQueryDto extends PaginationQueryDto {
  @IsOptional() @IsString() search?: string;

  @IsOptional() @IsString() requestId?: string;

  @IsOptional() @IsString() method?: string;

  @IsOptional() @Transform(({ value }) => toInt(value)) @IsInt() statusCode?: number;

  @IsOptional() @IsString() path?: string;

  @IsOptional() @Transform(({ value }) => toDate(value)) @IsDate() dateFrom?: Date;

  @IsOptional() @Transform(({ value }) => toDate(value)) @IsDate() dateTo?: Date;
}
