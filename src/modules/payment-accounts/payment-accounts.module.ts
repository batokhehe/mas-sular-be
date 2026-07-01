import { Module } from '@nestjs/common';
import { PaymentAccountsController } from './presentation/payment-accounts.controller';
import { PaymentAccountService } from './payment-account.service';

@Module({
  controllers: [PaymentAccountsController],
  providers: [PaymentAccountService],
  exports: [PaymentAccountService],
})
export class PaymentAccountsModule {}
