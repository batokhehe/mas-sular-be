/**
 * Indonesian Master Address seeder — idempotent (upsert on the Kemendagri `code`).
 *
 * Data source: `prisma/data/regions.full.json`, generated offline by
 * `prisma/tools/import-regions.ts` from the Kemendagri dataset
 * (Kepmendagri No 300.2.2-2138 Tahun 2025). Postal codes are enrichment only and
 * never determine a region's identity or its place in the hierarchy.
 *
 * There is deliberately NO fallback dataset. The previous curated sample was
 * removed because it silently seeded a partial hierarchy AND carried incorrect
 * administrative codes (it placed Coblong at 32.73.09, which officially belongs
 * to Bandung Wetan). A seed that quietly installs 4 of 514 cities, or the right
 * names under the wrong codes, is worse than one that refuses to run.
 *
 * Writes are BATCHED. The previous implementation issued one upsert per region,
 * which is ~91,600 sequential round trips; against the remote staging MySQL that
 * measured 4.7 rows/sec (~213 ms/row) and the connection was dropped after ~14
 * minutes, long before the ~5.4 hours it would have needed. Each level is now
 * one read, chunked createMany for the missing rows, and one bulk UPDATE per
 * chunk for the rows whose authoritative fields actually differ.
 *
 * Re-running is safe: `code` is the natural key at every level, rows are matched
 * on it, and unchanged rows are not written at all — so a second run creates
 * nothing, updates nothing, and existing database ids are preserved.
 *
 * Run:  npm run prisma:seed:address    (from backend/)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CityType, Prisma, PrismaClient } from '@prisma/client';
import type { ProvinceSeed } from './data/regions.types';

const prisma = new PrismaClient();

const DATASET = join(__dirname, 'data', 'regions.full.json');

/**
 * Loads the full Kemendagri dataset, or aborts. Every failure mode here is a
 * hard error: a missing or malformed dataset must never degrade into a partial
 * seed that looks like it worked.
 */
function loadProvinces(): ProvinceSeed[] {
  if (!existsSync(DATASET)) {
    throw new Error(
      `Missing ${DATASET}. Regenerate it offline with:\n` +
        `  npx tsx prisma/tools/import-regions.ts --source <dir with wilayah.sql and wilayah_kodepos.sql>`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(DATASET, 'utf8'));
  } catch (err) {
    throw new Error(`${DATASET} is not valid JSON: ${(err as Error).message}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${DATASET} is empty or not an array of provinces.`);
  }

  console.log(`[seed-address] Using Kemendagri dataset: ${DATASET} (${parsed.length} provinces)`);
  return parsed as ProvinceSeed[];
}

/** Rows are written in chunks of this size — one round trip per chunk, not per row. */
const CHUNK = 1000;

function chunked<T>(rows: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

interface LevelStats {
  created: number;
  updated: number;
  unchanged: number;
}

function report(level: string, s: LevelStats): void {
  console.log(`[seed-address]   ${level.padEnd(9)} created=${s.created} updated=${s.updated} unchanged=${s.unchanged}`);
}

/**
 * One bulk UPDATE per chunk, driven by `CASE code WHEN … THEN …`.
 *
 * Prisma has no batch-update-with-different-values primitive, and issuing one
 * updateMany per row is exactly the per-row round trip this seeder exists to
 * avoid. `updatedAt` is set explicitly because @updatedAt is applied by Prisma
 * Client, not by the database, so raw SQL would otherwise leave it stale.
 */
async function bulkUpdate(
  table: string,
  columns: string[],
  rows: Array<{ code: string; values: Array<string | number | null> }>,
): Promise<void> {
  for (const chunk of chunked(rows, 500)) {
    const assignments = columns.map((column, i) => {
      const cases = chunk.map((r) => Prisma.sql`WHEN ${r.code} THEN ${r.values[i]}`);
      return Prisma.sql`${Prisma.raw(`\`${column}\``)} = CASE \`code\` ${Prisma.join(cases, ' ')} END`;
    });
    await prisma.$executeRaw`
      UPDATE ${Prisma.raw(`\`${table}\``)}
         SET ${Prisma.join(assignments, ', ')}, \`updatedAt\` = NOW(3)
       WHERE \`code\` IN (${Prisma.join(chunk.map((r) => r.code))})`;
  }
}

async function main(): Promise<void> {
  const started = Date.now();
  const provinces = loadProvinces();

  // ---------------------------------------------------------------- Province --
  const flatProvinces = provinces.map((p) => ({ code: p.code, name: p.name }));
  const existingProvinces = await prisma.province.findMany({ select: { code: true, name: true } });
  const provinceByCode = new Map(existingProvinces.map((r) => [r.code, r]));

  const provinceStats: LevelStats = { created: 0, updated: 0, unchanged: 0 };
  const newProvinces = flatProvinces.filter((p) => !provinceByCode.has(p.code));
  const changedProvinces = flatProvinces.filter((p) => {
    const row = provinceByCode.get(p.code);
    return row && row.name !== p.name;
  });
  for (const chunk of chunked(newProvinces)) {
    await prisma.province.createMany({ data: chunk, skipDuplicates: true });
  }
  await bulkUpdate('Province', ['name'], changedProvinces.map((p) => ({ code: p.code, values: [p.name] })));
  provinceStats.created = newProvinces.length;
  provinceStats.updated = changedProvinces.length;
  provinceStats.unchanged = flatProvinces.length - newProvinces.length - changedProvinces.length;
  report('Province', provinceStats);

  // Ids are re-read once per level so children can resolve their parent by code.
  const provinceIds = new Map(
    (await prisma.province.findMany({ select: { id: true, code: true } })).map((r) => [r.code, r.id]),
  );

  // -------------------------------------------------------------------- City --
  const flatCities = provinces.flatMap((p) =>
    p.cities.map((c) => ({
      code: c.code,
      name: c.name,
      type: c.type as CityType,
      provinceId: provinceIds.get(p.code) as string,
    })),
  );
  const existingCities = await prisma.city.findMany({
    select: { code: true, name: true, type: true, provinceId: true },
  });
  const cityByCode = new Map(existingCities.map((r) => [r.code, r]));

  const newCities = flatCities.filter((c) => !cityByCode.has(c.code));
  const changedCities = flatCities.filter((c) => {
    const row = cityByCode.get(c.code);
    return row && (row.name !== c.name || row.type !== c.type || row.provinceId !== c.provinceId);
  });
  for (const chunk of chunked(newCities)) {
    await prisma.city.createMany({ data: chunk, skipDuplicates: true });
  }
  await bulkUpdate(
    'City',
    ['name', 'type', 'provinceId'],
    changedCities.map((c) => ({ code: c.code, values: [c.name, c.type, c.provinceId] })),
  );
  report('City', {
    created: newCities.length,
    updated: changedCities.length,
    unchanged: flatCities.length - newCities.length - changedCities.length,
  });

  const cityIds = new Map(
    (await prisma.city.findMany({ select: { id: true, code: true } })).map((r) => [r.code, r.id]),
  );

  // ---------------------------------------------------------------- District --
  const flatDistricts = provinces.flatMap((p) =>
    p.cities.flatMap((c) =>
      c.districts.map((d) => ({ code: d.code, name: d.name, cityId: cityIds.get(c.code) as string })),
    ),
  );
  const existingDistricts = await prisma.district.findMany({ select: { code: true, name: true, cityId: true } });
  const districtByCode = new Map(existingDistricts.map((r) => [r.code, r]));

  const newDistricts = flatDistricts.filter((d) => !districtByCode.has(d.code));
  const changedDistricts = flatDistricts.filter((d) => {
    const row = districtByCode.get(d.code);
    return row && (row.name !== d.name || row.cityId !== d.cityId);
  });
  for (const chunk of chunked(newDistricts)) {
    await prisma.district.createMany({ data: chunk, skipDuplicates: true });
  }
  await bulkUpdate(
    'District',
    ['name', 'cityId'],
    changedDistricts.map((d) => ({ code: d.code, values: [d.name, d.cityId] })),
  );
  report('District', {
    created: newDistricts.length,
    updated: changedDistricts.length,
    unchanged: flatDistricts.length - newDistricts.length - changedDistricts.length,
  });

  const districtIds = new Map(
    (await prisma.district.findMany({ select: { id: true, code: true } })).map((r) => [r.code, r.id]),
  );

  // ----------------------------------------------------------------- Village --
  const flatVillages = provinces.flatMap((p) =>
    p.cities.flatMap((c) =>
      c.districts.flatMap((d) =>
        d.villages.map((v) => ({
          code: v.code,
          name: v.name,
          postalCode: v.postalCode ?? null,
          districtId: districtIds.get(d.code) as string,
        })),
      ),
    ),
  );
  const existingVillages = await prisma.village.findMany({
    select: { code: true, name: true, postalCode: true, districtId: true },
  });
  const villageByCode = new Map(existingVillages.map((r) => [r.code, r]));

  const newVillages = flatVillages.filter((v) => !villageByCode.has(v.code));
  const changedVillages = flatVillages.filter((v) => {
    const row = villageByCode.get(v.code);
    return (
      row && (row.name !== v.name || (row.postalCode ?? null) !== v.postalCode || row.districtId !== v.districtId)
    );
  });
  for (const chunk of chunked(newVillages)) {
    await prisma.village.createMany({ data: chunk, skipDuplicates: true });
  }
  await bulkUpdate(
    'Village',
    ['name', 'postalCode', 'districtId'],
    changedVillages.map((v) => ({ code: v.code, values: [v.name, v.postalCode, v.districtId] })),
  );
  report('Village', {
    created: newVillages.length,
    updated: changedVillages.length,
    unchanged: flatVillages.length - newVillages.length - changedVillages.length,
  });

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `[seed-address] Done in ${elapsed}s. Provinces=${flatProvinces.length} Cities=${flatCities.length} ` +
      `Districts=${flatDistricts.length} Villages=${flatVillages.length}`,
  );

  await seedCoverageDemo();
}

/**
 * Demo delivery-coverage rules (idempotent — keyed by region scope). One of each
 * coverage type so checkout gating is verifiable end-to-end:
 *   - Kota Bandung → Coblong → Dago : DELIVERY  Rp10.000  (village rule)
 *   - Kota Bandung (city-level)      : DELIVERY  Rp15.000  (fallback)
 *   - Kabupaten Bandung → Cileunyi   : PICKUP_ONLY
 *   - Kota Surabaya (city-level)     : DISABLED
 *
 * The district/village codes below are the OFFICIAL Kemendagri ones. The values
 * used previously (32.73.09 for Coblong, 32.04.30 for Cileunyi) belong to
 * different regions entirely in the official dataset — Bandung Wetan and Pacet —
 * so against real data they would have attached each rule to the wrong place.
 */
async function seedCoverageDemo(): Promise<void> {
  const cityByCode = async (code: string) => prisma.city.findUnique({ where: { code } });
  const districtByCode = async (code: string) => prisma.district.findUnique({ where: { code } });
  const villageByCode = async (code: string) => prisma.village.findUnique({ where: { code } });

  const [bandungCity, coblong, dago, kabBandung, cileunyi, surabaya] = await Promise.all([
    cityByCode('32.73'),
    districtByCode('32.73.02'),
    villageByCode('32.73.02.1004'),
    cityByCode('32.04'),
    districtByCode('32.04.05'),
    cityByCode('35.78'),
  ]);

  const rules: Array<{
    provinceId: string;
    cityId: string;
    districtId: string | null;
    villageId: string | null;
    coverageType: 'DELIVERY' | 'PICKUP_ONLY' | 'DISABLED';
    deliveryFee: number;
    minimumOrder: number;
    estimatedMinutes: number;
  }> = [];

  if (bandungCity && coblong && dago) {
    rules.push({
      provinceId: bandungCity.provinceId,
      cityId: bandungCity.id,
      districtId: coblong.id,
      villageId: dago.id,
      coverageType: 'DELIVERY',
      deliveryFee: 10000,
      minimumOrder: 0,
      estimatedMinutes: 45,
    });
  }
  if (bandungCity) {
    rules.push({
      provinceId: bandungCity.provinceId,
      cityId: bandungCity.id,
      districtId: null,
      villageId: null,
      coverageType: 'DELIVERY',
      deliveryFee: 15000,
      minimumOrder: 25000,
      estimatedMinutes: 60,
    });
  }
  if (kabBandung && cileunyi) {
    rules.push({
      provinceId: kabBandung.provinceId,
      cityId: kabBandung.id,
      districtId: cileunyi.id,
      villageId: null,
      coverageType: 'PICKUP_ONLY',
      deliveryFee: 0,
      minimumOrder: 0,
      estimatedMinutes: 60,
    });
  }
  if (surabaya) {
    rules.push({
      provinceId: surabaya.provinceId,
      cityId: surabaya.id,
      districtId: null,
      villageId: null,
      coverageType: 'DISABLED',
      deliveryFee: 0,
      minimumOrder: 0,
      estimatedMinutes: 60,
    });
  }

  let count = 0;
  for (const rule of rules) {
    const existing = await prisma.deliveryCoverage.findFirst({
      where: {
        provinceId: rule.provinceId,
        cityId: rule.cityId,
        districtId: rule.districtId,
        villageId: rule.villageId,
      },
    });
    if (existing) {
      await prisma.deliveryCoverage.update({ where: { id: existing.id }, data: rule });
    } else {
      await prisma.deliveryCoverage.create({ data: rule });
    }
    count += 1;
  }
  console.log(`[seed-address] Delivery coverage demo rules upserted: ${count}`);
}

main()
  .catch((e) => {
    console.error('[seed-address] Failed:', e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
