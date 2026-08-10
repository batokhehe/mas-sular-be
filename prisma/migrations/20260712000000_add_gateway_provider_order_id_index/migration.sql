-- Phase 5A: correlation index for inbound gateway notifications. A Midtrans
-- notification identifies itself by the order_id we sent, which is stored in
-- PaymentGatewayTransaction.providerOrderId; without this index every webhook
-- lookup would be a full table scan.
--
-- Additive and NON-UNIQUE by design: existing rows may hold NULL, an empty
-- string, or a legacy bare order number, and none of those may block the
-- migration. No column, enum, or existing index is altered.
CREATE INDEX `PaymentGatewayTransaction_provider_providerOrderId_idx`
  ON `PaymentGatewayTransaction`(`provider`, `providerOrderId`);
