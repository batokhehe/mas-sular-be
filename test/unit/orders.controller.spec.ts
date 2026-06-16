import { OrdersController } from '../../src/modules/orders/presentation/orders.controller';

// B3: the non-idempotent POST /orders/checkout route was removed. Order creation
// must go only through the idempotent CheckoutController (POST /checkout/order).
describe('OrdersController — checkout bypass removed', () => {
  it('no longer exposes a checkout handler', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((OrdersController.prototype as any).checkout).toBeUndefined();
  });

  it('still exposes voucher preview and order history', () => {
    expect(typeof OrdersController.prototype.previewVoucher).toBe('function');
    expect(typeof OrdersController.prototype.listForUser).toBe('function');
  });
});
