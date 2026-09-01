/**
 * PAXELBOX-58: the acquisition entry point.
 * PAXELBOX-60F-A: wired to the hardened PAXELBOX-60E search planner.
 *
 * ---------------------------------------------------------------------------
 * THIS FILE SPENDS REAL QUOTA. IT IS DELIBERATELY AWKWARD TO RUN.
 *
 * Importing it does nothing: `main()` runs only when this file is the process
 * entry point, and even then it refuses without an explicit confirmation flag.
 * There is no npm script, no postinstall/prestart hook, and nothing in the
 * backend's startup path imports it. Reaching the network requires an operator
 * to type the command and the flag.
 *
 * It also cannot write to the database: no Prisma client is imported here, and
 * `Village.rajaOngkirId` is not touched. The run ends at a REVIEWABLE REPORT.
 * Backfilling is a separate, later, gated phase.
 *
 * Villages are read from a JSON file the operator supplies, not from the
 * database, so this tool holds no DB credentials and the plan stays
 * reproducible from a committed artifact.
 *
 *   node --import tsx prisma/tools/rajaongkir-acquire.ts \
 *     --villages ./kota-bandung-villages.json --dry-run
 *   node --import tsx prisma/tools/rajaongkir-acquire.ts \
 *     --villages ./kota-bandung-villages.json --confirm
 */

import * as fs from 'node:fs/promises';

import {
  poolFrom,
  runPaginatedAcquisition,
  type AcquiredUnit,
  type AcquisitionStorage,
  type RajaOngkirDestinationRaw,
} from './rajaongkir-acquisition';
import { buildSearchPlan, scopeViolations, toAcquisitionUnits, type SearchStrategy } from './rajaongkir-plan';
import { createFileStorage, CorruptArtifactError, DEFAULT_CACHE_ROOT } from './rajaongkir-storage';
import { createRajaOngkirTransport } from './rajaongkir-transport';
import { confirmedAliases } from './rajaongkir-province-alias';
import { aliasTables } from './rajaongkir-alias';
import { formatSample, mapVillages, type MassularVillage } from './rajaongkir-village-map';

export const CONFIRM_FLAG = '--confirm';
export const DRY_RUN_FLAG = '--dry-run';

export interface CliOptions {
  villagesPath: string;
  confirmed: boolean;
  dryRun: boolean;
  strategy: SearchStrategy;
  cacheRoot: string;
  acquisitionId: string;
}

export function parseArgs(argv: string[]): CliOptions {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const strategy = get('--strategy');
  if (strategy && strategy !== 'district' && strategy !== 'village') {
    throw new Error(`--strategy must be "district" or "village", got "${strategy}"`);
  }
  return {
    villagesPath: get('--villages') ?? '',
    confirmed: argv.includes(CONFIRM_FLAG),
    dryRun: argv.includes(DRY_RUN_FLAG),
    strategy: (strategy as SearchStrategy) ?? 'district',
    cacheRoot: get('--cache-root') ?? DEFAULT_CACHE_ROOT,
    acquisitionId: get('--id') ?? 'kota-bandung',
  };
}

/** Minimal shape check — a bad villages file must not become a bad plan. */
export function parseVillages(raw: unknown): MassularVillage[] {
  if (!Array.isArray(raw)) throw new Error('villages file must contain a JSON array');
  return raw.map((entry, i) => {
    const v = entry as Partial<MassularVillage>;
    for (const field of ['code', 'name', 'districtName', 'cityName', 'provinceName'] as const) {
      if (typeof v[field] !== 'string' || !v[field]) throw new Error(`village ${i}: "${field}" must be a non-empty string`);
    }
    if (v.postalCode !== null && typeof v.postalCode !== 'string') {
      throw new Error(`village ${i}: "postalCode" must be a string or null`);
    }
    return v as MassularVillage;
  });
}

/**
 * The reviewable plan table. Printed before ANY request, on both the dry run
 * and the real run, so an operator sees exactly what would be searched and
 * which districts are being held back.
 */
export function formatPlan(plan: ReturnType<typeof buildSearchPlan>): string {
  const lines = [
    `districts=${plan.districts}  units=${plan.all.length}  executable=${plan.units.length}  ` +
      `review_required=${plan.review.length}  village_token=${plan.villageTokenUnits.length}  ` +
      `limit=${plan.limit}  maxPages=${plan.maxPages}`,
    `totalPlannedRequests=${plan.totalPlannedRequests}  worstCaseRequests=${plan.worstCaseRequests}`,
    '',
    'district            strategy               term            maxP  review  completion',
  ];
  for (const u of plan.all) {
    lines.push(
      u.massularDistrict.padEnd(20) +
        u.strategy.padEnd(23) +
        (u.searchTerm ?? '—').padEnd(16) +
        String(u.maxPages).padEnd(6) +
        (u.requiresReview ? 'YES   ' : 'no    ') +
        u.expectedCompletion.join('|'),
    );
  }
  return lines.join('\n');
}

/**
 * PAXELBOX-60F-B: rebuild one unit from its stored artifact.
 *
 * The artifact is the shape `runPaginatedAcquisition` writes; anything else is
 * refused rather than coerced. A partially-recognised artifact would produce a
 * pool that looks plausible and is quietly short of rows.
 */
export function parseArtifact(unitKey: string, raw: unknown): AcquiredUnit {
  const bad = (reason: string): never => {
    throw new CorruptArtifactError(unitKey, reason);
  };
  if (!raw || typeof raw !== 'object') return bad('not an object');
  const a = raw as Record<string, unknown>;
  if (typeof a.searchTerm !== 'string') return bad('missing searchTerm');
  if (typeof a.limit !== 'number') return bad('missing limit');
  if (!Array.isArray(a.offsets)) return bad('missing offsets');
  if (!Array.isArray(a.pages)) return bad('missing pages');

  const rows: RajaOngkirDestinationRaw[] = [];
  const seen = new Set<number>();
  for (const page of a.pages) {
    if (!page || typeof page !== 'object') return bad('a page is not an object');
    const pageRows = (page as { rows?: unknown }).rows;
    if (!Array.isArray(pageRows)) return bad('a page has no rows array');
    for (const row of pageRows) {
      if (!row || typeof row !== 'object') return bad('a row is not an object');
      const r = row as RajaOngkirDestinationRaw;
      if (typeof r.id !== 'number' || !Number.isFinite(r.id)) return bad('a row has no numeric id');
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      rows.push(r);
    }
  }
  return { key: unitKey, searchTerm: a.searchTerm, limit: a.limit, offsets: a.offsets as number[], rows };
}

/**
 * The mapping pool for EVERY unit the checkpoint calls complete - not just the
 * ones this process fetched.
 *
 * A resumed run skips completed units, so `result.acquired` holds only today's
 * work. Mapping from that alone under-reports every district acquired on an
 * earlier day, which is what PAXELBOX-60F-A found. The checkpoint is the source
 * of truth here; artifacts are read back through the storage abstraction so the
 * CLI never needs to know how they are named or where they live.
 */
export async function reconstructAcquiredUnits(
  storage: AcquisitionStorage,
  completedUnits: string[],
): Promise<AcquiredUnit[]> {
  const units: AcquiredUnit[] = [];
  for (const key of completedUnits) {
    // Missing or unreadable artifacts THROW (MissingArtifactError /
    // CorruptArtifactError). Never treated as an empty district.
    units.push(parseArtifact(key, await storage.readRaw(key)));
  }
  return units;
}

export async function main(argv: string[]): Promise<number> {
  const opts = parseArgs(argv);

  if (!opts.villagesPath) {
    console.error('missing --villages <path to JSON array of Massular villages>');
    return 2;
  }
  // The hardened planner is district-based (PAXELBOX-60E). A village-level run
  // is a REVIEW_REQUIRED fallback proposal, not something to select on a flag.
  if (opts.strategy !== 'district') {
    console.error(
      `--strategy ${opts.strategy} is not supported by the hardened planner.\n` +
        'Village-level searching exists only as a per-district fallback PROPOSAL and needs review first.',
    );
    return 2;
  }
  if (!opts.confirmed && !opts.dryRun) {
    console.error(
      `refusing to run without ${CONFIRM_FLAG} (or ${DRY_RUN_FLAG} to plan offline).\n` +
        'This spends RajaOngkir daily quota, which is still unmeasured (PAXELBOX-57).',
    );
    return 2;
  }

  const villages = parseVillages(JSON.parse(await fs.readFile(opts.villagesPath, 'utf8')));

  // Scope guard BEFORE the key is read or a request is built: an out-of-scope
  // file must cost nothing.
  const violations = scopeViolations(villages);
  if (violations.length > 0) {
    console.error('villages file is outside the approved scope:');
    for (const v of violations) console.error(`  - ${v}`);
    return 3;
  }

  // PAXELBOX-60E planner. The CLI never builds a search term itself — it
  // consumes the plan, so a district the planner held back cannot be revived
  // here by falling back to its raw name.
  const plan = buildSearchPlan(villages, { reviewedAliases: {} });
  console.log(formatPlan(plan));

  // Invariant, checked out loud: planning must not lose a district.
  if (plan.units.length + plan.review.length !== plan.all.length) {
    console.error('planner invariant violated: executable + review !== all districts');
    return 5;
  }

  if (plan.review.length > 0) {
    console.log(`\n${plan.review.length} district(s) held back as REVIEW_REQUIRED and will NOT be requested:`);
    for (const u of plan.review) {
      console.log(`  - ${u.massularDistrict} (${u.villages} villages): ${u.reason}`);
      if (u.fallback) {
        console.log(`      fallback PROPOSAL (needs review): ${u.fallback.strategy} -> ${u.fallback.terms.join(', ')}`);
      }
    }
  }

  // toAcquisitionUnits is the single conversion boundary: it refuses any unit
  // without a search term, so a REVIEW_REQUIRED district cannot reach the runner.
  const units = toAcquisitionUnits(plan);

  if (opts.dryRun) {
    console.log(`\n${DRY_RUN_FLAG}: ${units.length} executable unit(s) planned. No request was made.`);
    return 0;
  }

  const transport = createRajaOngkirTransport(process.env.RAJAONGKIR_API_KEY);
  const storage = createFileStorage(opts.cacheRoot);

  const result = await runPaginatedAcquisition(units, transport, storage, {
    acquisitionId: opts.acquisitionId,
  });

  console.log(
    `requests=${result.requests} completed=${result.unitsCompleted} ` +
      `skipped=${result.unitsSkipped} stopped=${result.stopped}`,
  );

  if (result.stopped) {
    const f = result.failure;
    console.error(`STOPPED on unit "${f?.unit}": ${f?.category} — ${f?.message}`);
    console.error('No mapping was produced. Re-run to resume from the checkpoint.');
    return 1;
  }

  // Rebuild the pool from EVERY completed unit, not just this run's, so a
  // resumed run maps against the whole dataset (PAXELBOX-60F-B).
  let acquired: AcquiredUnit[];
  try {
    acquired = await reconstructAcquiredUnits(storage, result.checkpoint.completedUnits);
  } catch (err) {
    console.error(`RESUME_ARTIFACT_UNUSABLE: ${err instanceof Error ? err.message : String(err)}`);
    console.error('The mapping cannot be presented as complete. No mapping was produced.');
    return 6;
  }
  console.log(
    `pool reconstructed from ${acquired.length} completed unit(s) ` +
      `(${result.unitsCompleted} acquired now, ${result.unitsSkipped} resumed from checkpoint)`,
  );

  // Classification happens ONLY here, on the complete pool of every unit.
  // Province aliases stay empty; the district/village tables are the operator-
  // approved PAXELBOX-60H set. An alias only widens candidate GATHERING — the
  // postal code still decides, so this cannot manufacture a match.
  const report = mapVillages(villages, poolFrom(acquired), {
    province: confirmedAliases(),
    ...aliasTables(),
  });
  console.log(formatSample(report));

  if (!report.safeToApply) {
    console.error('mapping is NOT safe to apply:');
    for (const b of report.blockers) console.error(`  - ${b}`);
    return 4;
  }

  console.log('Mapping is reviewable. NOTHING was written to the database — backfill is a separate phase.');
  return 0;
}

// Runs only as the process entry point. An import does nothing: `require.main`
// is this module ONLY when node was pointed at this file directly.
if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
