import { IsOptional, IsString } from 'class-validator';
import { IsAppUploadUrl } from '../validators/is-app-upload-url.validator';

export class UploadManualPaymentDto {
  // Must be an application-owned upload produced by the receipt-file endpoint;
  // arbitrary/external URLs are rejected.
  @IsString()
  @IsAppUploadUrl()
  receiptUrl!: string;

  @IsOptional()
  @IsString()
  bankName?: string;

  @IsOptional()
  @IsString()
  accountName?: string;
}
