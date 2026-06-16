import { IsInt, IsString, Min } from 'class-validator';

export class ShippingRateDto {
  @IsString()
  originPostalCode!: string;

  @IsString()
  destinationPostalCode!: string;

  @IsInt()
  @Min(1)
  weightGram!: number;
}
