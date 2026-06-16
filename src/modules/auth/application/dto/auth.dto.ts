import { IsString } from 'class-validator';

export class GoogleLoginDto {
  @IsString()
  idToken!: string;
}

export class RefreshTokenDto {
  @IsString()
  refreshToken!: string;
}
