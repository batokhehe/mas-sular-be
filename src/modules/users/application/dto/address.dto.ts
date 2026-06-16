import { IsBoolean, IsNumber, IsOptional, IsString, Length, MinLength } from 'class-validator';

export class CreateAddressDto {
  @IsString()
  label!: string;

  @IsString()
  @MinLength(2)
  recipientName!: string;

  @IsString()
  @Length(10, 15)
  phone!: string;

  @IsString()
  @MinLength(10)
  fullAddress!: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsNumber()
  latitude!: number;

  @IsNumber()
  longitude!: number;

  @IsBoolean()
  isDefault!: boolean;
}

export class UpdateAddressDto {
  @IsOptional()
  @IsString()
  label?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  recipientName?: string;

  @IsOptional()
  @IsString()
  @Length(10, 15)
  phone?: string;

  @IsOptional()
  @IsString()
  @MinLength(10)
  fullAddress?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @IsNumber()
  longitude?: number;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
