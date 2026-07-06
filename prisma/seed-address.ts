/**
 * Indonesian Master Address seeder — idempotent (upsert on unique `code`).
 *
 * Data source precedence:
 *   1. `prisma/data/regions.full.json` (official full dataset, if you drop it in)
 *   2. `prisma/data/regions.sample.ts` (curated real sample committed to the repo)
 *
 * Re-running is safe: every row is upserted by its Kemendagri `code`, so no
 * duplicates are ever created and existing rows are updated in place.
 *
 * Run:  npm run prisma:seed:address    (from backend/)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CityType, PrismaClient } from '@prisma/client';
import { PROVINCES, type ProvinceSeed } from './data/regions.sample';

const prisma = new PrismaClient();

function loadProvinces(): ProvinceSeed[] {
  const fullPath = join(__dirname, 'data', 'regions.full.json');
  if (existsSync(fullPath)) {
    try {
      const parsed = JSON.parse(readFileSync(fullPath, 'utf8')) as ProvinceSeed[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        console.log(`[seed-address] Using full dataset: ${fullPath}`);
        return parsed;
      }
    } catch (err) {
      console.warn(`[seed-address] Failed to parse regions.full.json, falling back to sample:`, err);
    }
  }
  console.log('[seed-address] Using curated sample dataset (prisma/data/regions.sample.ts)');
  return PROVINCES;
}

async function main(): Promise<void> {
  const provinces = loadProvinces();
  let pCount = 0;
  let cCount = 0;
  let dCount = 0;
  let vCount = 0;

  for (const province of provinces) {
    const p = await prisma.province.upsert({
      where: { code: province.code },
      update: { name: province.name },
      create: { code: province.code, name: province.name },
    });
    pCount += 1;

    for (const city of province.cities ?? []) {
      const c = await prisma.city.upsert({
        where: { code: city.code },
        update: { name: city.name, type: city.type as CityType, provinceId: p.id },
        create: { code: city.code, name: city.name, type: city.type as CityType, provinceId: p.id },
      });
      cCount += 1;

      for (const district of city.districts ?? []) {
        const d = await prisma.district.upsert({
          where: { code: district.code },
          update: { name: district.name, cityId: c.id },
          create: { code: district.code, name: district.name, cityId: c.id },
        });
        dCount += 1;

        for (const village of district.villages ?? []) {
          await prisma.village.upsert({
            where: { code: village.code },
            update: { name: village.name, postalCode: village.postalCode, districtId: d.id },
            create: {
              code: village.code,
              name: village.name,
              postalCode: village.postalCode,
              districtId: d.id,
            },
          });
          vCount += 1;
        }
      }
    }
  }

  console.log(
    `[seed-address] Done. Provinces=${pCount} Cities=${cCount} Districts=${dCount} Villages=${vCount}`,
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
 */
async function seedCoverageDemo(): Promise<void> {
  const cityByCode = async (code: string) => prisma.city.findUnique({ where: { code } });
  const districtByCode = async (code: string) => prisma.district.findUnique({ where: { code } });
  const villageByCode = async (code: string) => prisma.village.findUnique({ where: { code } });

  const [bandungCity, coblong, dago, kabBandung, cileunyi, surabaya] = await Promise.all([
    cityByCode('32.73'),
    districtByCode('32.73.09'),
    villageByCode('32.73.09.1005'),
    cityByCode('32.04'),
    districtByCode('32.04.30'),
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
