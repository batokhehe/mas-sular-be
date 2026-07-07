import { LogLevel } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsDate, IsEnum, IsIn, IsInt, IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from '../../../../common/pagination/pagination';

const toDate = (value: unknown): Date | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? undefined : d;
};
const toInt = (value: unknown): number | undefined =>
  value === undefined || value === '' ? undefined : Number(value);

export class ListSystemLogsQueryDto extends PaginationQueryDto {
  @IsOptional() @IsString() search?: string;

  @IsOptional() @IsEnum(LogLevel) level?: LogLevel;

  @IsOptional() @IsString() module?: string;

  @IsOptional() @IsString() action?: string;

  @IsOptional() @IsString() requestId?: string;

  @IsOptional() @IsString() userId?: string;

  @IsOptional() @IsString() orderId?: string;

  @IsOptional() @IsString() paymentId?: string;

  @IsOptional() @Transform(({ value }) => toInt(value)) @IsInt() statusCode?: number;

  @IsOptional() @Transform(({ value }) => toDate(value)) @IsDate() dateFrom?: Date;

  @IsOptional() @Transform(({ value }) => toDate(value)) @IsDate() dateTo?: Date;

  @IsOptional() @IsIn(['asc', 'desc']) sort?: 'asc' | 'desc';
}
