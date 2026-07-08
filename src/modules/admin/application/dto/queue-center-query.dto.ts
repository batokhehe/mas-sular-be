import { NotificationChannel, NotificationStatus, OutboxStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsDate, IsEnum, IsIn, IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from '../../../../common/pagination/pagination';

const toDate = (value: unknown): Date | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

export class ListOutboxQueryDto extends PaginationQueryDto {
  @IsOptional() @IsEnum(OutboxStatus) status?: OutboxStatus;

  @IsOptional() @IsString() event?: string;

  @IsOptional() @IsString() aggregate?: string;

  @IsOptional() @IsString() search?: string;

  @IsOptional() @Transform(({ value }) => toDate(value)) @IsDate() dateFrom?: Date;

  @IsOptional() @Transform(({ value }) => toDate(value)) @IsDate() dateTo?: Date;
}

export class ListQueueNotificationsQueryDto extends PaginationQueryDto {
  @IsOptional() @IsEnum(NotificationChannel) channel?: NotificationChannel;

  @IsOptional() @IsEnum(NotificationStatus) status?: NotificationStatus;

  @IsOptional() @IsString() template?: string;

  @IsOptional() @IsString() search?: string;
}

export class RetryAllFailedDto {
  @IsOptional() @IsIn(['outbox', 'notifications', 'all']) target?: 'outbox' | 'notifications' | 'all';
}
