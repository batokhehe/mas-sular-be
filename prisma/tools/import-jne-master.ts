/**
 * PAXELBOX-61E: operator-controlled import of the JNE destination master data.
 *
 * ---------------------------------------------------------------------------
 * SHAPE, AND WHY
 *
 * This follows `import-regions.ts`: an OFFLINE transformer that reads a captured
 * snapshot and produces a reviewable JSON artifact. It makes no HTTP request —
 * the snapshot comes from the PAXELBOX-61C discovery call and is never re-fetched
 * here, so running this tool can never spend JNE quota or change what was
 * observed.
 *
 * ---------------------------------------------------------------------------
 * THE DATABASE WRITE IS DELIBERATELY SEPARATE
 *
 * `--emit` transforms and verifies; `--confirm` additionally writes. The write
 * requires migration 20260901000000_add_jne_master_data to have been applied,
 * because `JneLocation` does not otherwise exist. That migration is intentionally
 * UNAPPLIED, so `--confirm` will fail until an operator applies it deliberately.
 * The default path therefore proves the transform is correct without touching a
 * production database holding real orders.
 *
 *   npx tsx prisma/tools/import-jne-master.ts --snapshot <file> --emit <out.json>
 *   npx tsx prisma/tools/import-jne-master.ts --snapshot <file> --confirm
 */

import { readFileSync, writeFileSync } from 'node:fs';

import {
  assertExpectedRowCount,
  computeImportDiff,
  expectedRowsFor,
  toJneLocationSeeds,
  validateJneMasterPayload,
  type ImportDiff,
  type JneDataSource,
  type JneLocationKind,
  type JneLocationSeed,
} from './jne-master';

export const CONFIRM_FLAG = '--confirm';

export interface ImportOptions {
  snapshotPath: string;
  emitPath: string;
  confirmed: boolean;
  overrideRowCount: boolean;
  kind: JneLocationKind;
  source: JneDataSource;
}

export function parseArgs(argv: string[]): ImportOptions {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const kind = get('--kind');
  if (kind && kind !== 'ORIGIN' && kind !== 'DESTINATION') {
    throw new Error(`--kind must be ORIGIN or DESTINATION, got "${kind}"`);
  }
  const source = get('--source');
  if (source && source !== 'SANDBOX' && source !== 'PRODUCTION') {
    throw new Error(`--source must be SANDBOX or PRODUCTION, got "${source}"`);
  }
  return {
    snapshotPath: get('--snapshot') ?? '',
    emitPath: get('--emit') ?? '',
    confirmed: argv.includes(CONFIRM_FLAG),
    overrideRowCount: argv.includes('--override-row-count'),
    kind: (kind as JneLocationKind) ?? 'DESTINATION',
    source: (source as JneDataSource) ?? 'SANDBOX',
  };
}

/**
 * A 61C-style capture: `{ status, headers, text }` where `text` is the verbatim
 * response body. A bare `{ detail: [...] }` payload is accepted too, so a
 * snapshot taken any other way still works.
 */
export function extractPayload(fileContents: string): { payload: unknown; fetchedAt: string | null } {
  const outer = JSON.parse(fileContents) as { status?: number; text?: string; headers?: Array<[string, string]> };
  if (typeof outer?.text === 'string') {
    if (outer.status !== undefined && outer.status !== 200) {
      throw new Error(`snapshot records HTTP ${outer.status}; refusing to import a non-200 capture`);
    }
    const date = outer.headers?.find(([k]) => k.toLowerCase() === 'date')?.[1] ?? null;
    return { payload: JSON.parse(outer.text), fetchedAt: date };
  }
  return { payload: outer, fetchedAt: null };
}

export function formatDiff(diff: ImportDiff): string {
  return [
    `  total source rows   : ${diff.sourceRows}`,
    `  unique codes        : ${diff.uniqueCodes}`,
    `  new codes           : ${diff.newCodes.length}`,
    `  existing codes      : ${diff.existingCodes.length}`,
    `  changed rawName     : ${diff.changedRawName.length}`,
    `  deactivated codes   : ${diff.deactivatedCodes.length}`,
    `  invalid/test codes  : ${diff.invalidOrTestCodes.length}` +
      (diff.invalidOrTestCodes.length ? ` -> ${diff.invalidOrTestCodes.join(', ')}` : ''),
  ].join('\n');
}

/**
 * Verify every seed still carries its source row verbatim. This is the strongest
 * guarantee the phase asks for, so it is checked rather than assumed: a
 * normalisation bug that rewrote `rawName` would otherwise be invisible.
 */
export function verifyRawNames(
  seeds: JneLocationSeed[],
  rows: Array<{ City_Name: string; City_Code: string }>,
): { checked: number; mismatches: Array<{ code: string; expected: string; actual: string }> } {
  const byCode = new Map(rows.map((r) => [r.City_Code, r.City_Name]));
  const mismatches: Array<{ code: string; expected: string; actual: string }> = [];
  for (const s of seeds) {
    const expected = byCode.get(s.code);
    if (expected === undefined || expected !== s.rawName) {
      mismatches.push({ code: s.code, expected: expected ?? '<absent>', actual: s.rawName });
    }
  }
  return { checked: seeds.length, mismatches };
}

export async function main(argv: string[]): Promise<number> {
  const opts = parseArgs(argv);
  if (!opts.snapshotPath) {
    console.error('missing --snapshot <path to the captured getdestination response>');
    return 2;
  }

  const { payload, fetchedAt } = extractPayload(readFileSync(opts.snapshotPath, 'utf8'));

  // Fails closed on a malformed envelope, a blank field or a duplicate code.
  const rows = validateJneMasterPayload(payload);
  // Per-namespace: the destination master is 8,322 rows and the origin master
  // 614, so one shared constant cannot guard both.
  assertExpectedRowCount(rows.length, expectedRowsFor(opts.kind), opts.overrideRowCount);

  const sourceFetchedAt = fetchedAt ? new Date(fetchedAt).toISOString() : new Date().toISOString();
  const seeds = toJneLocationSeeds(rows, { kind: opts.kind, source: opts.source, sourceFetchedAt });

  const verification = verifyRawNames(seeds, rows);
  if (verification.mismatches.length > 0) {
    console.error(`rawName was not preserved for ${verification.mismatches.length} row(s) — refusing to continue`);
    for (const m of verification.mismatches.slice(0, 5)) console.error(`  ${m.code}: "${m.expected}" -> "${m.actual}"`);
    return 4;
  }

  console.log(`snapshot: ${opts.snapshotPath}`);
  console.log(`kind=${opts.kind} source=${opts.source} sourceFetchedAt=${sourceFetchedAt}`);
  console.log(`rawName preserved for ${verification.checked}/${seeds.length} row(s), 0 mismatches`);

  // Diff against an empty database: this tool never reads Prisma, so a real
  // existing set is supplied by the caller that owns the connection.
  console.log('\nimport diff (against an empty JneLocation table):');
  console.log(formatDiff(computeImportDiff(seeds, [])));

  if (opts.emitPath) {
    writeFileSync(opts.emitPath, `${JSON.stringify(seeds, null, 2)}\n`, 'utf8');
    console.log(`\nemitted ${seeds.length} seed row(s) -> ${opts.emitPath}`);
  }

  if (!opts.confirmed) {
    console.log(`\nno database write. Pass ${CONFIRM_FLAG} to persist (requires the migration to be applied).`);
    return 0;
  }

  // ---- database write ------------------------------------------------------
  // Prisma is required LAZILY, so every path above stays free of a database
  // dependency and the transform can be verified with no connection at all.
  //
  // This tool never creates schema. If `JneLocation` is missing it says so and
  // stops, rather than half-building a table.
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    // Scoped to THIS namespace. Reading every row would make the diff compare an
    // origin snapshot against destination rows, and `deactivatedCodes` would then
    // list ~7,700 destinations as "absent from the snapshot" and retire them.
    const existing = (await prisma.jneLocation.findMany({
      where: { kind: opts.kind },
      select: { code: true, rawName: true },
    })) as Array<{ code: string; rawName: string }>;

    const diff = computeImportDiff(seeds, existing);
    console.log('\nimport diff (against the live table):');
    console.log(formatDiff(diff));

    const fetchedAt = new Date(sourceFetchedAt);
    let written = 0;
    // Upsert by `code`, the natural key.
    for (const seed of seeds) {
      await prisma.jneLocation.upsert({
        // (code, kind), never code alone: 601 origin codes also exist as
        // destinations, 62 of them under a different name (PAXELBOX-61P).
        where: { code_kind: { code: seed.code, kind: seed.kind } },
        create: { ...seed, sourceFetchedAt: fetchedAt },
        update: {
          rawName: seed.rawName,
          normalizedName: seed.normalizedName,
          parsedChild: seed.parsedChild,
          parsedParent: seed.parsedParent,
          partCount: seed.partCount,
          kind: seed.kind,
          source: seed.source,
          sourceFetchedAt: fetchedAt,
          isActive: seed.isActive,
        },
      });
      written += 1;
    }

    // Codes absent from this snapshot are DEACTIVATED, never deleted: a reviewed
    // mapping must never be left pointing at a row that vanished.
    let deactivated = 0;
    if (diff.deactivatedCodes.length > 0) {
      const r = await prisma.jneLocation.updateMany({
        where: { code: { in: diff.deactivatedCodes }, kind: opts.kind },
        data: { isActive: false },
      });
      deactivated = r.count;
    }

    const total = await prisma.jneLocation.count();
    const inKind = await prisma.jneLocation.count({ where: { kind: opts.kind } });
    const mappings = await prisma.jneDistrictMapping.count();
    console.log(`\nwritten ${written} row(s); deactivated ${deactivated}; ${opts.kind} rows ${inKind}; JneLocation total ${total}`);
    console.log(`JneDistrictMapping rows: ${mappings} (this tool never creates mappings)`);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/JneLocation|does not exist|doesn't exist|Unknown table/i.test(message)) {
      console.error(
        '\nrefusing to continue: the JneLocation table does not exist. Apply migration\n' +
          '20260901000000_add_jne_master_data deliberately first. This tool never creates schema.',
      );
      return 5;
    }
    throw err;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
