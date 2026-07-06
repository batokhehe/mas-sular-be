import {
  IsBoolean,
  IsNumber,
  IsNumberString,
  IsOptional,
  IsString,
  Length,
  MinLength,
} from 'class-validator';

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

  // --- Indonesian administrative hierarchy (optional for backward compatibility;
  // the new chain-select forms send them, legacy/free-text callers may omit). ---
  @IsOptional()
  @IsString()
  addressDetail?: string;

  @IsOptional()
  @IsString()
  provinceId?: string;

  @IsOptional()
  @IsString()
  cityId?: string;

  @IsOptional()
  @IsString()
  districtId?: string;

  @IsOptional()
  @IsString()
  villageId?: string;

  @IsOptional()
  @IsNumberString({ no_symbols: true }, { message: 'postalCode must be numeric' })
  @Length(5, 5, { message: 'postalCode must be exactly 5 digits' })
  postalCode?: string;
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

  @IsOptional()
  @IsString()
  addressDetail?: string;

  @IsOptional()
  @IsString()
  provinceId?: string;

  @IsOptional()
  @IsString()
  cityId?: string;

  @IsOptional()
  @IsString()
  districtId?: string;

  @IsOptional()
  @IsString()
  villageId?: string;

  @IsOptional()
  @IsNumberString({ no_symbols: true }, { message: 'postalCode must be numeric' })
  @Length(5, 5, { message: 'postalCode must be exactly 5 digits' })
  postalCode?: string;
}
