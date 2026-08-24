/**
 * OFFLINE transformer: Kemendagri administrative data -> prisma/data/regions.full.json
 *
 * This is a build-time/maintenance tool. It is NOT part of the application or the
 * seed runtime: the seeder only ever reads the generated JSON, so seeding works
 * with no network access.
 *
 * ---------------------------------------------------------------------------
 * SOURCE OF TRUTH (administrative identity, hierarchy, codes, classification)
 *   cahyadsn/wilayah  —  db/wilayah.sql
 *   Kepmendagri No 300.2.2-2138 Tahun 2025
 *   table: wilayah(kode varchar(13) PRIMARY KEY, nama varchar(100))
 *
 * ENRICHMENT ONLY (never determines identity or hierarchy)
 *   cahyadsn/wilayah_kodepos  —  db/wilayah_kodepos.sql
 *   table: wilayah_kodepos(kode varchar(13) PRIMARY KEY, kodepos varchar(5))
 *
 * REGENERATE:
 *   mkdir -p /tmp/wilayah && cd /tmp/wilayah
 *   curl -LO https://raw.githubusercontent.com/cahyadsn/wilayah/master/db/wilayah.sql
 *   curl -LO https://raw.githubusercontent.com/cahyadsn/wilayah_kodepos/main/db/wilayah_kodepos.sql
 *   npx tsx prisma/tools/import-regions.ts --source /tmp/wilayah
 *
 * The level of a region is derived from its Kemendagri code, and every
 * parent/child link is verified by CODE PREFIX rather than by trusting any
 * source-provided parent id:
 *   31             province
 *   31.74          regency/city
 *   31.74.07       district
 *   31.74.07.1001  village
 * ---------------------------------------------------------------------------
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type {
  CityTypeSeed,
  CitySeed,
  DistrictSeed,
  ProvinceSeed,
  VillageSeed,
} from '../data/regions.types';

const CODE_PATTERNS: Record<number, RegExp> = {
  0: /^\d{2}$/,
  1: /^\d{2}\.\d{2}$/,
  2: /^\d{2}\.\d{2}\.\d{2}$/,
  3: /^\d{2}\.\d{2}\.\d{2}\.\d{4}$/,
};

function fail(message: string): never {
  console.error(`[import-regions] FAILED: ${message}`);
  process.exit(1);
}

/** Parses `('<kode>','<value>')` tuples out of a MySQL dump. */
function parseTuples(sql: string): Array<[string, string]> {
  const re = /\('([0-9.]{2,13})',\s*'?((?:[^']|'')*?)'?\)/g;
  const out: Array<[string, string]> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    out.push([m[1], m[2].replace(/''/g, "'")]);
  }
  return out;
}

const levelOf = (code: string): number => code.split('.').length - 1;
const parentOf = (code: string): string => code.slice(0, code.lastIndexOf('.'));

/** Kemendagri names carry the official designation; it is not a name heuristic. */
function cityTypeOf(name: string): CityTypeSeed {
  const trimmed = name.trim();
  if (/^Kota\b/i.test(trimmed)) return 'CITY';
  if (/^Kabupaten\b/i.test(trimmed)) return 'REGENCY';
  return fail(`city "${trimmed}" carries no official Kota/Kabupaten designation — refusing to guess CityType`);
}

function main(): void {
  const args = process.argv.slice(2);
  const sourceIdx = args.indexOf('--source');
  if (sourceIdx === -1 || !args[sourceIdx + 1]) {
    fail('usage: tsx prisma/tools/import-regions.ts --source <dir containing wilayah.sql and wilayah_kodepos.sql>');
  }
  const sourceDir = resolve(args[sourceIdx + 1]);
  const wilayahPath = join(sourceDir, 'wilayah.sql');
  const kodeposPath = join(sourceDir, 'wilayah_kodepos.sql');
  for (const p of [wilayahPath, kodeposPath]) {
    if (!existsSync(p)) fail(`missing source file: ${p} (see the REGENERATE block at the top of this file)`);
  }

  const regions = new Map<string, string>();
  for (const [code, name] of parseTuples(readFileSync(wilayahPath, 'utf8'))) {
    if (regions.has(code)) fail(`duplicate region code in source: ${code}`);
    if (!name.trim()) fail(`empty name for code ${code}`);
    const pattern = CODE_PATTERNS[levelOf(code)];
    if (!pattern || !pattern.test(code)) fail(`malformed administrative code: ${code}`);
    regions.set(code, name.trim());
  }

  const postal = new Map<string, string>();
  for (const [code, value] of parseTuples(readFileSync(kodeposPath, 'utf8'))) {
    const trimmed = value.trim();
    if (!/^\d{5}$/.test(trimmed)) continue; // never store a malformed postal code
    postal.set(code, trimmed);
  }

  const provinces: ProvinceSeed[] = [];
  const cityByCode = new Map<string, CitySeed>();
  const districtByCode = new Map<string, DistrictSeed>();
  const provinceByCode = new Map<string, ProvinceSeed>();

  const sorted = [...regions.keys()].sort();
  for (const code of sorted) {
    const name = regions.get(code) as string;
    switch (levelOf(code)) {
      case 0: {
        const province: ProvinceSeed = { code, name, cities: [] };
        provinceByCode.set(code, province);
        provinces.push(province);
        break;
      }
      case 1: {
        // Parentage is established by code prefix, not by a source parent id.
        const province = provinceByCode.get(parentOf(code));
        if (!province) fail(`orphan city ${code} "${name}": province ${parentOf(code)} not found`);
        const city: CitySeed = { code, name, type: cityTypeOf(name), districts: [] };
        cityByCode.set(code, city);
        province.cities.push(city);
        break;
      }
      case 2: {
        const city = cityByCode.get(parentOf(code));
        if (!city) fail(`orphan district ${code} "${name}": city ${parentOf(code)} not found`);
        const district: DistrictSeed = { code, name, villages: [] };
        districtByCode.set(code, district);
        city.districts.push(district);
        break;
      }
      case 3: {
        const district = districtByCode.get(parentOf(code));
        if (!district) fail(`orphan village ${code} "${name}": district ${parentOf(code)} not found`);
        const postalCode = postal.get(code);
        // Enrichment only: a village with no trusted postal code is still a
        // valid region. It is simply left without one rather than guessed at.
        district.villages.push({ code, name, ...(postalCode ? { postalCode } : {}) } as VillageSeed);
        break;
      }
      default:
        fail(`unexpected administrative level for code ${code}`);
    }
  }

  const cities = cityByCode.size;
  const districts = districtByCode.size;
  const villages = [...districtByCode.values()].reduce((n, d) => n + d.villages.length, 0);
  const withPostal = [...districtByCode.values()].reduce(
    (n, d) => n + d.villages.filter((v) => v.postalCode).length,
    0,
  );

  if (provinces.length === 0 || cities === 0 || districts === 0 || villages === 0) {
    fail('refusing to emit an empty or partial dataset');
  }

  const outPath = join(__dirname, '..', 'data', 'regions.full.json');
  writeFileSync(outPath, JSON.stringify(provinces), 'utf8');

  console.log('[import-regions] source: cahyadsn/wilayah (Kepmendagri No 300.2.2-2138 Tahun 2025)');
  console.log(`[import-regions] provinces=${provinces.length} cities=${cities} districts=${districts} villages=${villages}`);
  console.log(`[import-regions] postal codes populated: ${withPostal}/${villages} (${((100 * withPostal) / villages).toFixed(2)}%)`);
  console.log(`[import-regions] wrote ${outPath}`);
}

main();
