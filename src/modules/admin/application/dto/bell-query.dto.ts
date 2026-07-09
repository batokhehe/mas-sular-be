import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

export const BELL_CATEGORIES = ['ORDER', 'PAYMENT', 'INVENTORY', 'SYSTEM', 'SECURITY', 'AUDIT'] as const;
export const BELL_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

/** Cursor-paginated bell feed query. Malformed input → 400, never a 500. */
export class BellListQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  cursor?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  // Explicit transform reading the RAW value: implicit conversion coerces ANY
  // non-empty string (including "false") to true before @Transform runs.
  @IsOptional()
  @Transform(({ obj }) => (obj as Record<string, unknown>).unread === true || (obj as Record<string, unknown>).unread === 'true')
  unread?: boolean;

  @IsOptional()
  @IsIn(BELL_CATEGORIES)
  category?: string;
}

export class RegisterPushDto {
  @IsString() @MinLength(10) @MaxLength(512) token!: string;
  @IsOptional() @IsString() @MaxLength(64) browser?: string;
  @IsOptional() @IsString() @MaxLength(64) platform?: string;
  @IsOptional() @IsString() @MaxLength(64) device?: string;
}

export class ManualNotificationDto {
  @IsString() @MinLength(1) @MaxLength(255) title!: string;
  @IsString() @MinLength(1) @MaxLength(2000) message!: string;

  // In-app deep link only: must be a relative path ("/orders/x"), never an
  // absolute/external or protocol-relative ("//host") URL other bells would open.
  @IsOptional()
  @IsString()
  @MaxLength(512)
  @Matches(/^\/(?!\/)/, { message: 'url must be a relative path starting with "/"' })
  url?: string;

  @IsOptional() @IsIn(BELL_CATEGORIES) category?: string;
  @IsOptional() @IsIn(BELL_PRIORITIES) priority?: string;
}
