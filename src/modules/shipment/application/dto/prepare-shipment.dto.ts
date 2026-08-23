import { ArrayNotEmpty, IsArray, IsDateString, IsIn, IsOptional, IsString } from 'class-validator';

/** The four Paxel services this application books. */
export const PAXEL_BOOKABLE_SERVICES = ['PAXEL_INSTANT', 'PAXEL_SAMEDAY', 'PAXEL_NEXTDAY', 'PAXEL_REGULAR'] as const;

export class PrepareShipmentDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  orderIds!: string[];

  /**
   * The pickup slot the admin committed to, ISO-8601.
   *
   * Required, and never defaulted: a courier pickup is a real appointment, and
   * the application has no operating-hours model from which a sensible time
   * could be derived. The exact value is stored and sent to Paxel unchanged.
   */
  @IsDateString()
  pickupAt!: string;

  /** Optional override; otherwise the service quoted at checkout is used. */
  @IsOptional()
  @IsIn(PAXEL_BOOKABLE_SERVICES as unknown as string[])
  service?: string;
}
