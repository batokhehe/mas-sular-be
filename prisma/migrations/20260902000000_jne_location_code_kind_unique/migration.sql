-- PAXELBOX-61P: scope JneLocation's natural key to its namespace.
--
-- JNE serves two masters and they overlap: 601 of the 614 origin codes also
-- exist as destinations, and 62 of those carry a different name in each -- e.g.
-- CBN20300 is "MAJALENGKA" as an origin and "MAJALENGKA, KAB MAJALENGKA" as a
-- destination. With a GLOBAL unique on `code`, importing the origin master would
-- upsert straight over 601 destination rows: their `kind` would flip to ORIGIN
-- and 62 `rawName`s would change underneath the approved JneDistrictMapping rows
-- that reference them by id. The mappings would still resolve, and would then be
-- pointing at origins.
--
-- Uniqueness is not weakened, it is corrected: a code stays unique within its
-- own namespace, which is the only scope in which JNE actually issues it.
--
-- Safe to apply against existing data: every row written so far is DESTINATION,
-- so (code, kind) is already unique across them and no row is touched.
DROP INDEX `JneLocation_code_key` ON `JneLocation`;

CREATE UNIQUE INDEX `JneLocation_code_kind_key` ON `JneLocation`(`code`, `kind`);
