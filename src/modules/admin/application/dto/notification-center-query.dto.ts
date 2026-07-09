import { NotificationChannel, NotificationStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsDate, IsEnum, IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from '../../../../common/pagination/pagination';

const toDate = (value: unknown): Date | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? undefined : d;
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
}
