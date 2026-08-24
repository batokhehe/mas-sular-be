/**
 * Shape of `prisma/data/regions.full.json` — the Kemendagri administrative
 * master dataset consumed by `prisma/seed-address.ts`.
 *
 * `code` is the Kemendagri administrative code and is the natural key for every
 * level. It is what the seeder upserts on, and what delivery-coverage lookups
 * key off, so it must never be synthesised:
 *
 *   31             province
 *   31.74          regency/city
 *   31.74.07       district
 *   31.74.07.1001  village
 *
 * Regenerate the JSON with `prisma/tools/import-regions.ts` (offline).
 */

export type CityTypeSeed = 'CITY' | 'REGENCY';

export interface VillageSeed {
  code: string;
  name: string;
  /** Enrichment only. Absent when no trusted postal code exists — never guessed. */
  postalCode?: string;
}

export interface DistrictSeed {
  code: string;
  name: string;
  villages: VillageSeed[];
}

export interface CitySeed {
  code: string;
  name: string;
  /** Derived from the official Kemendagri designation (Kota / Kabupaten). */
  type: CityTypeSeed;
  districts: DistrictSeed[];
}

export interface ProvinceSeed {
  code: string;
  name: string;
  cities: CitySeed[];
}
