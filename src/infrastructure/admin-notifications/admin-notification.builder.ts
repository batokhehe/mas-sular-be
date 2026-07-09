/**
 * PURE notification builder. Maps a domain event (name + payload) to a display
 * draft via a mapper REGISTRY — supporting a new event is one `registerMapper`
 * call; workers never hardcode messages. No I/O.
 */

export type NotificationPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type NotificationCategory = 'ORDER' | 'PAYMENT' | 'INVENTORY' | 'SYSTEM' | 'SECURITY' | 'AUDIT';

export interface NotificationDraft {
  eventType: string;
  category: NotificationCategory;
  priority: NotificationPriority;
  title: string;
  message: string;
  url: string | null;
  icon: string | null;
  metadata?: Record<string, unknown>;
}

type Payload = Record<string, unknown>;
type Mapper = (payload: Payload) => NotificationDraft | null;

const registry = new Map<string, Mapper>();

/** Future events plug in here — no worker/dispatcher changes needed. */
export function registerNotificationMapper(eventName: string, mapper: Mapper): void {
  registry.set(eventName, mapper);
}

/** Build the display draft for an event; null → event not notification-worthy. */
export function buildAdminNotification(eventName: string, payload: unknown): NotificationDraft | null {
  const mapper = registry.get(eventName);
  if (!mapper) return null;
  try {
    return mapper((payload ?? {}) as Payload);
  } catch {
    return null; // a broken payload must never break the worker
  }
}

export function supportedNotificationEvents(): string[] {
  return [...registry.keys()];
}

// ---------------- helpers ----------------

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' && v.length ? v : fallback);
const rp = (v: unknown): string => `Rp ${Math.round(Number(v ?? 0)).toLocaleString('id-ID')}`;

// ---------------- built-in mappers ----------------

registerNotificationMapper('order.created', (p) => ({
  eventType: 'order.created',
  category: 'ORDER',
  priority: 'HIGH',
  title: 'New Order Received',
  message: `Order ${str(p.orderNumber, 'baru')} · Total ${rp(p.totalPrice)}`,
  url: p.orderId ? `/orders/${str(p.orderId)}` : '/orders',
  icon: 'shopping-cart',
  metadata: { orderId: p.orderId ?? null, orderNumber: p.orderNumber ?? null },
}));

registerNotificationMapper('payment.receipt_uploaded', (p) => ({
  eventType: 'payment.uploaded',
  category: 'PAYMENT',
  priority: 'HIGH',
  title: 'Payment Receipt Uploaded',
  message: 'A transfer receipt is waiting for verification.',
  url: '/payments',
  icon: 'upload',
  metadata: { paymentId: p.paymentId ?? null, orderId: p.orderId ?? null },
}));

registerNotificationMapper('payment.paid', (p) => ({
  eventType: 'payment.verified',
  category: 'PAYMENT',
  priority: 'MEDIUM',
  title: 'Payment Verified',
  message: `Payment ${rp(p.amount)} verified — order moved to processing.`,
  url: p.orderId ? `/orders/${str(p.orderId)}` : '/orders',
  icon: 'check-circle',
  metadata: { paymentId: p.paymentId ?? null, orderId: p.orderId ?? null },
}));

registerNotificationMapper('payment.failed', (p) => ({
  eventType: 'payment.rejected',
  category: 'PAYMENT',
  priority: 'HIGH',
  title: 'Payment Rejected',
  message: 'A payment was rejected and the order cancelled (stock restored).',
  url: p.orderId ? `/orders/${str(p.orderId)}` : '/payments',
  icon: 'x-circle',
  metadata: { paymentId: p.paymentId ?? null, orderId: p.orderId ?? null },
}));

registerNotificationMapper('payment.expired', (p) => ({
  eventType: 'payment.expired',
  category: 'PAYMENT',
  priority: 'LOW',
  title: 'Payment Expired',
  message: 'A pending payment expired and its order was cancelled.',
  url: p.orderId ? `/orders/${str(p.orderId)}` : '/orders',
  icon: 'clock',
  metadata: { paymentId: p.paymentId ?? null, orderId: p.orderId ?? null },
}));

// order.status_updated fans into shipped / cancelled / generic update.
registerNotificationMapper('order.status_updated', (p) => {
  const status = str(p.status).toUpperCase();
  if (status === 'SHIPPED') {
    return {
      eventType: 'order.shipped',
      category: 'ORDER',
      priority: 'MEDIUM',
      title: 'Order Shipped',
      message: `Order ${str(p.orderNumber, '')} handed to the courier.`.trim(),
      url: p.orderId ? `/orders/${str(p.orderId)}` : '/orders',
      icon: 'truck',
      metadata: { orderId: p.orderId ?? null },
    };
  }
  if (status === 'CANCELLED') {
    return {
      eventType: 'order.cancelled',
      category: 'ORDER',
      priority: 'HIGH',
      title: 'Order Cancelled',
      message: `Order ${str(p.orderNumber, '')} was cancelled.`.trim(),
      url: p.orderId ? `/orders/${str(p.orderId)}` : '/orders',
      icon: 'x-circle',
      metadata: { orderId: p.orderId ?? null },
    };
  }
  return null; // routine status hops are not bell-worthy
});

registerNotificationMapper('stock.low', (p) => ({
  eventType: 'stock.low',
  category: 'INVENTORY',
  priority: 'MEDIUM',
  title: 'Low Stock',
  message: `${str(p.productName, 'A product')} is low on stock (${Number(p.stock ?? 0)} left).`,
  url: '/inventory/products',
  icon: 'package',
  metadata: { productId: p.productId ?? null, stock: p.stock ?? null },
}));

registerNotificationMapper('stock.out', (p) => ({
  eventType: 'stock.out',
  category: 'INVENTORY',
  priority: 'HIGH',
  title: 'Out of Stock',
  message: `${str(p.productName, 'A product')} is out of stock.`,
  url: '/inventory/products',
  icon: 'package-x',
  metadata: { productId: p.productId ?? null },
}));

registerNotificationMapper('manual.notification', (p) => ({
  eventType: 'manual.notification',
  category: (str(p.category, 'SYSTEM').toUpperCase() as NotificationCategory) || 'SYSTEM',
  priority: (str(p.priority, 'MEDIUM').toUpperCase() as NotificationPriority) || 'MEDIUM',
  title: str(p.title, 'Announcement'),
  message: str(p.message, ''),
  url: str(p.url) || null,
  icon: 'megaphone',
}));

registerNotificationMapper('system.warning', (p) => ({
  eventType: 'system.warning',
  category: 'SYSTEM',
  priority: 'MEDIUM',
  title: str(p.title, 'System Warning'),
  message: str(p.message, ''),
  url: str(p.url) || '/system/incidents',
  icon: 'alert-triangle',
}));

registerNotificationMapper('system.error', (p) => ({
  eventType: 'system.error',
  category: 'SYSTEM',
  priority: 'CRITICAL',
  title: str(p.title, 'System Error'),
  message: str(p.message, ''),
  url: str(p.url) || '/system/incidents',
  icon: 'alert-octagon',
}));
