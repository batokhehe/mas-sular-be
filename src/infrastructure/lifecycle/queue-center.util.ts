/** PURE helpers for the Queue Center (no I/O — unit-testable standalone). */

export type QueueHealth = 'green' | 'yellow' | 'red';

export interface RelatedRefs {
  requestId: string | null;
  orderId: string | null;
  orderNumber: string | null;
  paymentId: string | null;
  shipmentId: string | null;
  customerId: string | null;
}

/**
 * Extract related entity references from an event/notification JSON payload so
 * the drawer can link to Order / Payment / Shipment / Request. Top-level string
 * keys only — never a deep scan (payloads are author-controlled and shallow).
 */
export function extractRelated(payload: unknown): RelatedRefs {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  return {
    requestId: str(p.requestId),
    orderId: str(p.orderId),
    orderNumber: str(p.orderNumber),
    paymentId: str(p.paymentId),
    shipmentId: str(p.shipmentId),
    customerId: str(p.customerId) ?? str(p.userId),
  };
}

/**
 * Backlog health thresholds (same scale the System Dashboard uses):
 * red = large backlog or mass failure; yellow = any failure / moderate backlog.
 */
export function queueHealth(pending: number, failed: number): QueueHealth {
  if (pending >= 1000 || failed >= 100) return 'red';
  if (failed > 0 || pending >= 100) return 'yellow';
  return 'green';
}
/** PURE helpers for the Queue Center (no I/O — unit-testable standalone). */

export type QueueHealth = 'green' | 'yellow' | 'red';

export interface RelatedRefs {
  requestId: string | null;
  orderId: string | null;
  orderNumber: string | null;
  paymentId: string | null;
  shipmentId: string | null;
}

/**
 * Extract related entity references from an event/notification JSON payload so
 * the drawer can link to Order / Payment / Shipment / Request. Top-level string
 * keys only — never a deep scan (payloads are author-controlled and shallow).
 */
export function extractRelated(payload: unknown): RelatedRefs {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  return {
    requestId: str(p.requestId),
    orderId: str(p.orderId),
    orderNumber: str(p.orderNumber),
    paymentId: str(p.paymentId),
    shipmentId: str(p.shipmentId),
  };
}

/**
 * Backlog health thresholds (same scale the System Dashboard uses):
 * red = large backlog or mass failure; yellow = any failure / moderate backlog.
 */
export function queueHealth(pending: number, failed: number): QueueHealth {
  if (pending >= 1000 || failed >= 100) return 'red';
  if (failed > 0 || pending >= 100) return 'yellow';
  return 'green';
}
