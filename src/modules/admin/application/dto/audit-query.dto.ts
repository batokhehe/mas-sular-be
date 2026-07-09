import { Transform } from 'class-transformer';
import { IsBoolean, IsDate, IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from '../../../../common/pagination/pagination';

const toDate = (value: unknown): Date | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? undefined : d;
};
const toBool = (value: unknown): boolean | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  return value === 'true' || value === '1';
};

export class ListAuditQueryDto extends PaginationQueryDto {
  @IsOptional() @IsString() module?: string;

  @IsOptional() @IsString() action?: string;

  @IsOptional() @IsString() admin?: string;

  @IsOptional() @IsString() entity?: string;

  @IsOptional() @IsString() entityId?: string;

  @IsOptional() @Transform(({ value }) => toBool(value)) @IsBoolean() success?: boolean;

  @IsOptional() @IsString() search?: string;

  @IsOptional() @Transform(({ value }) => toDate(value)) @IsDate() dateFrom?: Date;

  @IsOptional() @Transform(({ value }) => toDate(value)) @IsDate() dateTo?: Date;
}
