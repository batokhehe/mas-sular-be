import { NotificationChannel, NotificationStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDate, IsEnum, IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { PaginationQueryDto } from '../../../../common/pagination/pagination';

const toDate = (value: unknown): Date | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

const toInt = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
};

const toBool = (value: unknown): boolean | undefined => {
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  return undefined;
};

export class ListNotificationCenterQueryDto extends PaginationQueryDto {
  @IsOptional() @IsEnum(NotificationChannel) channel?: NotificationChannel;

  @IsOptional() @IsEnum(NotificationStatus) status?: NotificationStatus;

  @IsOptional() @IsString() template?: string;

  @IsOptional() @IsString() recipient?: string;

  @IsOptional() @IsString() order?: string;

  @IsOptional() @IsString() payment?: string;

  @IsOptional() @IsString() search?: string;

  @IsOptional() @Transform(({ value }) => toDate(value)) @IsDate() dateFrom?: Date;

  @IsOptional() @Transform(({ value }) => toDate(value)) @IsDate() dateTo?: Date;

  // ---- Advanced filters ----

  /** Delivery provider (maps onto the channel it serves). */
  @IsOptional() @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value)) @IsIn(['QONTAK', 'RESEND']) provider?: string;

  /** true → rows with a lastError; false → rows without one. */
  @IsOptional() @Transform(({ value }) => toBool(value)) @IsBoolean() hasError?: boolean;

  /** Minimum attempt count (e.g. 2 = retried at least once). */
  @IsOptional() @Transform(({ value }) => toInt(value)) @IsInt() @Min(0) retryMin?: number;

  /** Delivery duration bounds in seconds (SENT rows only). */
  @IsOptional() @Transform(({ value }) => toInt(value)) @IsInt() @Min(0) durationMin?: number;

  @IsOptional() @Transform(({ value }) => toInt(value)) @IsInt() @Min(0) durationMax?: number;
}

/** Bulk resend body — bounded so a stray request can never mass-redrive. */
export class BulkResendNotificationsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  ids!: string[];
}
