import { IsOptional, IsString } from 'class-validator';

export class GoogleLoginDto {
  @IsString()
  idToken!: string;
}

export class RefreshTokenDto {
  // Phase 13A.2: optional so a cookie-only refresh (empty body) is accepted.
  // Existing clients sending { refreshToken } continue to work unchanged.
  @IsOptional()
  @IsString()
  refreshToken?: string;
}
