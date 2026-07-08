import { IncidentSeverity, IncidentStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsDate, IsEnum, IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from '../../../../common/pagination/pagination';

const toDate = (value: unknown): Date | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

export class ListIncidentsQueryDto extends PaginationQueryDto {
  @IsOptional() @IsEnum(IncidentStatus) status?: IncidentStatus;

  @IsOptional() @IsEnum(IncidentSeverity) severity?: IncidentSeverity;

  @IsOptional() @IsString() source?: string;

  @IsOptional() @IsString() worker?: string;

  @IsOptional() @IsString() module?: string;

  @IsOptional() @Transform(({ value }) => toDate(value)) @IsDate() dateFrom?: Date;

  @IsOptional() @Transform(({ value }) => toDate(value)) @IsDate() dateTo?: Date;
}
