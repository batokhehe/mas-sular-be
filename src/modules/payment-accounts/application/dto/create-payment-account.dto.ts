import { IsBoolean, IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';

export class CreatePaymentAccountDto {
  @IsString()
  @MinLength(2)
  bankName!: string;

  @IsOptional()
  @IsString()
  bankCode?: string;

  @IsString()
  @MinLength(2)
  accountName!: string;

  @IsString()
  @MinLength(2)
  accountNumber!: string;

  @IsOptional()
  @IsString()
  logoUrl?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsBoolean()
  isVisible?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  displayOrder?: number;
}
