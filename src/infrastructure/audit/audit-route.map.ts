/**
 * PURE mapping from an admin HTTP mutation to an audit descriptor. Explicit rules
 * for the named business actions + a generic CREATE/UPDATE/DELETE fallback for
 * every other /admin mutation, so new admin modules are audited automatically.
 */

export interface AuditRouteMatch {
  module: string;
  entity: string;
  action: string;
}

type Body = Record<string, unknown> | undefined;

interface Rule {
  method: string;
  pattern: RegExp;
  resolve: (body: Body) => AuditRouteMatch | null;
}

const m = (module: string, entity: string, action: string): AuditRouteMatch => ({ module, entity, action });

const RULES: Rule[] = [
  // Never audit the audit endpoints themselves (no recursion noise).
  { method: '*', pattern: /\/admin\/system\/audit(\/|$)/, resolve: () => null },

  { method: 'POST', pattern: /\/admin\/auth\/login$/, resolve: () => m('auth', 'Admin', 'LOGIN') },
  { method: 'POST', pattern: /\/admin\/auth\/logout$/, resolve: () => m('auth', 'Admin', 'LOGOUT') },

  { method: 'PATCH', pattern: /\/admin\/payments\/[^/]+\/verify$/, resolve: () => m('payments', 'Payment', 'VERIFY_PAYMENT') },
  { method: 'PATCH', pattern: /\/admin\/payments\/[^/]+\/reject$/, resolve: () => m('payments', 'Payment', 'REJECT_PAYMENT') },
  { method: 'PATCH', pattern: /\/admin\/payment-accounts\/[^/]+\/activate$/, resolve: () => m('payments', 'PaymentAccount', 'APPROVE') },

  {
    method: 'PATCH',
    pattern: /\/admin\/orders\/[^/]+\/status$/,
    resolve: (body) => m('orders', 'Order', body?.status === 'CANCELLED' ? 'CANCEL_ORDER' : 'UPDATE'),
  },
  { method: 'POST', pattern: /\/admin\/orders\/[^/]+\/shipment\/retry$/, resolve: () => m('shipping', 'Shipment', 'SHIP_ORDER') },
  { method: 'POST', pattern: /\/admin\/shipments$/, resolve: () => m('shipping', 'Shipment', 'SHIP_ORDER') },

  { method: 'POST', pattern: /\/admin\/stock-transfers$/, resolve: () => m('inventory', 'StockTransfer', 'TRANSFER_STOCK') },
  { method: 'PATCH', pattern: /\/admin\/stock-transfers\/[^/]+\/approve$/, resolve: () => m('inventory', 'StockTransfer', 'APPROVE') },
  { method: 'PATCH', pattern: /\/admin\/stock-transfers\/[^/]+\/complete$/, resolve: () => m('inventory', 'StockTransfer', 'TRANSFER_STOCK') },
  { method: 'POST', pattern: /\/admin\/product-inventory\/adjust$/, resolve: () => m('inventory', 'ProductInventory', 'UPDATE') },

  {
    method: 'PATCH',
    pattern: /\/admin\/users\/[^/]+$/,
    resolve: (body) => m('users', 'User', body && 'roleId' in body ? (body.roleId ? 'ASSIGN_ROLE' : 'REMOVE_ROLE') : 'UPDATE'),
  },

  { method: 'POST', pattern: /\/upload$/, resolve: () => m('uploads', 'File', 'UPLOAD_IMAGE') },

  { method: 'POST', pattern: /\/admin\/system\/queues\/.*retry/, resolve: () => m('system', 'Queue', 'RETRY') },
  { method: 'POST', pattern: /\/admin\/system\/incidents\/[^/]+\/acknowledge$/, resolve: () => m('system', 'Incident', 'ACKNOWLEDGE') },
  { method: 'POST', pattern: /\/admin\/system\/incidents\/[^/]+\/resolve$/, resolve: () => m('system', 'Incident', 'APPROVE') },
  { method: 'POST', pattern: /\/admin\/system\/notifications\/[^/]+\/resend$/, resolve: () => m('system', 'Notification', 'SEND_MANUAL_NOTIFICATION') },
];

const METHOD_ACTION: Record<string, string> = { POST: 'CREATE', PATCH: 'UPDATE', PUT: 'UPDATE', DELETE: 'DELETE' };

const singularTitle = (segment: string): string => {
  const clean = segment.replace(/-/g, ' ');
  const singular = clean.endsWith('ies') ? `${clean.slice(0, -3)}y` : clean.endsWith('s') ? clean.slice(0, -1) : clean;
  return singular.replace(/(^|\s)\w/g, (c) => c.toUpperCase()).replace(/\s/g, '');
};

/** Map an admin mutation to its audit descriptor; null → not audited. */
export function mapAuditRoute(method: string, path: string, body?: Body): AuditRouteMatch | null {
  const verb = method.toUpperCase();
  if (!(verb in METHOD_ACTION)) return null;

  for (const rule of RULES) {
    if ((rule.method === '*' || rule.method === verb) && rule.pattern.test(path)) return rule.resolve(body);
  }

  // Generic fallback for any other admin mutation: /admin/<segment>/...
  const match = path.match(/\/admin\/(?:catalog\/|cms\/|system\/)?([a-z-]+)/i);
  if (!match) return null;
  const segment = match[1].toLowerCase();
  if (segment === 'auth') return null; // refresh/me etc. — not human actions worth auditing
  return { module: segment, entity: singularTitle(segment), action: METHOD_ACTION[verb] };
}

/** Prisma delegate per entity — lets the interceptor snapshot the BEFORE state. */
export const ENTITY_DELEGATES: Record<string, string> = {
  Product: 'product',
  Category: 'category',
  Promo: 'promo',
  Banner: 'banner',
  Order: 'order',
  Payment: 'payment',
  Shipment: 'shipment',
  User: 'user',
  Role: 'role',
  Outlet: 'outlet',
  PaymentAccount: 'paymentAccount',
  DeliveryCoverage: 'deliveryCoverage',
  StockTransfer: 'stockTransfer',
  Incident: 'incident',
};
