import { Transform } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const toInt = (value: unknown): number | undefined =>
  value === undefined || value === '' ? undefined : Number(value);

/** Reusable page/limit query params for admin list endpoints. */
export class PaginationQueryDto {
  @IsOptional()
  @Transform(({ value }) => toInt(value))
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Transform(({ value }) => toInt(value))
  @IsInt()
  @Min(1)
  limit?: number;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** Normalize page/limit → Prisma skip/take. page ≥ 1; limit clamped to [1, 100] (default 20). */
export function pageArgs(query: { page?: number; limit?: number }): {
  skip: number;
  take: number;
  page: number;
  limit: number;
} {
  const page = Math.max(1, Math.trunc(query.page ?? 1) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(query.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT));
  return { skip: (page - 1) * limit, take: limit, page, limit };
}

export function paginate<T>(items: T[], total: number, page: number, limit: number): Paginated<T> {
  return { items, page, limit, total, totalPages: Math.ceil(total / limit) };
}
