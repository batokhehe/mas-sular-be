import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

/**
 * Midtrans HTTP notification payload.
 *
 * Only the four fields the signature is computed over are REQUIRED; everything
 * else is optional because Midtrans varies its payload by channel (VA numbers,
 * bill keys, card metadata, …) and adds fields over time.
 *
 * The route applies its own ValidationPipe with `forbidNonWhitelisted: false`
 * so an unrecognised future Midtrans field is accepted rather than 400'd — a
 * rejected notification would be retried forever for no reason.
 *
 * `gross_amount` is typed as a STRING on purpose and the route disables implicit
 * conversion: the signature must be computed over the exact text received.
 */
export class MidtransWebhookDto {
  // --- signature inputs (required) ---
  @IsString()
  @IsNotEmpty()
  order_id!: string;

  @IsString()
  @IsNotEmpty()
  status_code!: string;

  @IsString()
  @IsNotEmpty()
  gross_amount!: string;

  @IsString()
  @IsNotEmpty()
  signature_key!: string;

  // --- identity / status (optional; consumed from Phase 5C onward) ---
  @IsOptional() @IsString() transaction_id?: string;
  @IsOptional() @IsString() transaction_status?: string;
  @IsOptional() @IsString() fraud_status?: string;
  @IsOptional() @IsString() payment_type?: string;
  @IsOptional() @IsString() transaction_time?: string;
  @IsOptional() @IsString() settlement_time?: string;
  @IsOptional() @IsString() status_message?: string;
  @IsOptional() @IsString() merchant_id?: string;
  @IsOptional() @IsString() currency?: string;
}
