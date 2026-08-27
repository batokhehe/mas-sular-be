-- PAXELBOX-41: RajaOngkir district mapping foundation.
--
-- Additive and reversible: one NULLABLE column, no default, no backfill, no
-- constraint. Existing rows are untouched and every one of them keeps a NULL,
-- which the rate path must read as "no JNE quote for this district".
--
-- Deliberately NOT unique: a one-to-one correspondence between Kemendagri
-- districts and RajaOngkir districts is not proven, so the guarantee is enforced
-- by the import tool (which refuses to emit duplicates) rather than asserted here.
ALTER TABLE `District` ADD COLUMN `rajaOngkirId` INT NULL;
