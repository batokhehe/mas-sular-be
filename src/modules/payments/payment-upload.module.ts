import { Module } from '@nestjs/common';
import { PaymentUploadTokenService } from './payment-upload-token.service';
import { PAYMENT_UNIQUE_CODE_CONFIG, loadPaymentUniqueCodeConfig } from './payment-unique-code.config';
import { PaymentUniqueCodeService } from './payment-unique-code.service';

/** Provides the single-use payment-upload token lifecycle to checkout + payments. */
@Module({
  providers: [
    PaymentUploadTokenService,
    { provide: PAYMENT_UNIQUE_CODE_CONFIG, useFactory: () => loadPaymentUniqueCodeConfig() },
    PaymentUniqueCodeService,
  ],
  exports: [PaymentUploadTokenService, PaymentUniqueCodeService],
})
export class PaymentUploadModule {}
