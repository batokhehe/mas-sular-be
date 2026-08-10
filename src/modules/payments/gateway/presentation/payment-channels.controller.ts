import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../../../common/guards/jwt-auth.guard';
import { PublicPaymentChannel } from '../domain/payment-channel';
import { PaymentChannelRegistry } from '../payment-channel.registry';
import { PaymentInitiationService } from '../payment-initiation.service';

/**
 * Public payment-channel catalog for the checkout UI.
 *
 * Unauthenticated by design (it is a static catalog, same trust level as the
 * product list) — no authentication behavior anywhere else changes. The response
 * NEVER carries a provider/gateway name; only `code`, `label`, `group`, `method`,
 * and `logoUrl` cross the boundary.
 *
 * Lives on the existing `payments` path but does not collide with
 * PaymentsController: that controller declares no single-segment GET route.
 */
@ApiTags('payments')
@Controller({ path: 'payments', version: '1' })
export class PaymentChannelsController {
  constructor(
    private readonly channels: PaymentChannelRegistry,
    private readonly initiation: PaymentInitiationService,
  ) {}

  /** GET /api/v1/payments/channels — channels a customer can actually use today. */
  @Get('channels')
  list(): { channels: PublicPaymentChannel[] } {
    return { channels: this.channels.listPublic() };
  }

  /**
   * GET /api/v1/payments/:paymentId/instructions — rebuild an OPEN gateway
   * attempt for the payment-detail page (reload/deep link). Ownership-scoped and
   * strictly read-only: it reads the ledger and never contacts the provider, so
   * refreshing the page can never create a second charge. Returns
   * `{ gateway: null }` for manual transfer, which keeps its existing pages.
   */
  @Get(':paymentId/instructions')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  async instructions(@Param('paymentId') paymentId: string, @CurrentUser() user: AuthUser) {
    return { gateway: await this.initiation.getInstructions(paymentId, user.sub) };
  }
}
