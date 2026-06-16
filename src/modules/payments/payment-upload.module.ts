import { Module } from '@nestjs/common';
import { PaymentUploadTokenService } from './payment-upload-token.service';

/** Provides the single-use payment-upload token lifecycle to checkout + payments. */
@Module({
  providers: [PaymentUploadTokenService],
  exports: [PaymentUploadTokenService],
})
export class PaymentUploadModule {}
