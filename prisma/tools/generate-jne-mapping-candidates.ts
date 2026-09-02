/**
 * PAXELBOX-61F: generate REVIEW_REQUIRED JNE mapping candidates, and — as a
 * SEPARATE operation — approve them.
 *
 * ---------------------------------------------------------------------------
 * GENERATION AND APPROVAL ARE DIFFERENT COMMANDS
 *
 * `--generate` writes candidates, every one REVIEW_REQUIRED. `--approve`
 * promotes named districts to MATCHED. They are deliberately separate so that
 * "the resolver found exactly one candidate" can never be mistaken for "a human
 * agreed". Approval takes explicit district names and a reviewer, and refuses to
 * approve anything the resolver did not leave in REVIEW_REQUIRED.
 *
 *   npx tsx prisma/tools/generate-jne-mapping-candidates.ts --city "Kota Bandung" --generate
 *   npx tsx prisma/tools/generate-jne-mapping-candidates.ts --city "Kota Bandung" \
 *     --approve "Andir,Cicendo" --reviewer "ops@example"
 */

import {
  approvalDecision,
  resolveDistrictCandidates,
  type InternalDistrict,
  type JneCandidateRow,
  type MappingCandidate,
} from './jne-district-mapping';

export interface CliOptions {
  city: string;
  generate: boolean;
  approve: string[];
  reviewer: string;
  dryRun: boolean;
}

export function parseArgs(argv: string[]): CliOptions {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const approve = get('--approve');
  return {
    city: get('--city') ?? 'Kota Bandung',
    generate: argv.includes('--generate'),
    approve: approve ? approve.split(',').map((s) => s.trim()).filter(Boolean) : [],
    reviewer: get('--reviewer') ?? '',
    dryRun: argv.includes('--dry-run'),
  };
}

export function formatCandidates(candidates: MappingCandidate[]): string {
  const lines = ['district              status           method           jne code   jne raw name'];
  for (const c of candidates) {
    lines.push(
      c.district.name.padEnd(22) +
        c.status.padEnd(17) +
        c.method.padEnd(17) +
        (c.evidence.jneCode ?? '—').padEnd(11) +
        (c.evidence.jneRawName ?? '—'),
    );
  }
  return lines.join('\n');
}

/* eslint-disable @typescript-eslint/no-var-requires */
export async function main(argv: string[]): Promise<number> {
  const opts = parseArgs(argv);
  if (!opts.generate && opts.approve.length === 0) {
    console.error('nothing to do: pass --generate, or --approve "<District,District>" --reviewer <who>');
    return 2;
  }

  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  const prisma = new PrismaClient();

  try {
    // ---- approval is its own path, and never runs alongside generation.
    if (opts.approve.length > 0) {
      if (!opts.reviewer) {
        console.error('--approve requires --reviewer <who>: an approval must name a person');
        return 2;
      }
      let promoted = 0;
      for (const name of opts.approve) {
        const district = await prisma.district.findFirst({
          where: { name, city: { name: opts.city } },
          select: { id: true, name: true },
        });
        if (!district) {
          console.error(`  no district "${name}" in ${opts.city} — skipped`);
          continue;
        }
        // The guard lives in the WHERE clause, so only a REVIEW_REQUIRED row can
        // be promoted. `approvalDecision` states the same rule in one place and
        // is what the offline tests exercise.
        const existing = await prisma.jneDistrictMapping.findMany({
          where: { districtId: district.id },
          select: { status: true },
        });
        const decisions = existing.map((e) => approvalDecision(e.status as never));
        if (decisions.length > 0 && decisions.every((d) => d.alreadyApproved)) {
          console.log(`  ${name} already approved — no change (idempotent)`);
          continue;
        }
        const blocked = decisions.filter((d) => !d.promotable && !d.alreadyApproved);
        if (blocked.length > 0 && decisions.every((d) => !d.promotable)) {
          console.error(`  "${name}" cannot be approved: ${blocked[0].reason} — skipped`);
          continue;
        }

        const r = await prisma.jneDistrictMapping.updateMany({
          where: { districtId: district.id, status: 'REVIEW_REQUIRED' },
          data: { status: 'MATCHED', reviewedBy: opts.reviewer, reviewedAt: new Date() },
        });
        if (r.count === 0) {
          console.error(`  "${name}" has no REVIEW_REQUIRED candidate to approve — skipped`);
          continue;
        }
        promoted += r.count;
        console.log(`  approved ${name}`);
      }
      console.log(`\npromoted ${promoted} mapping(s) to MATCHED by ${opts.reviewer}`);
      return 0;
    }

    // ---- generation
    const districts = (await prisma.district.findMany({
      where: { city: { name: opts.city } },
      select: {
        id: true,
        name: true,
        city: { select: { id: true, name: true, type: true, province: { select: { id: true, name: true } } } },
      },
      orderBy: { code: 'asc' },
    })) as Array<{
      id: string;
      name: string;
      city: { id: string; name: string; type: string; province: { id: string; name: string } };
    }>;

    if (districts.length === 0) {
      console.error(`no districts found for city "${opts.city}"`);
      return 3;
    }

    const internal: InternalDistrict[] = districts.map((d) => ({
      id: d.id,
      name: d.name,
      cityId: d.city.id,
      cityName: d.city.name,
      cityType: d.city.type as 'CITY' | 'REGENCY',
      provinceId: d.city.province.id,
      provinceName: d.city.province.name,
    }));

    // Only active SANDBOX destinations are eligible; the resolver re-checks.
    const rows = (await prisma.jneLocation.findMany({
      where: { kind: 'DESTINATION', source: 'SANDBOX', isActive: true },
      select: { id: true, code: true, rawName: true, parsedChild: true, parsedParent: true, kind: true, source: true, isActive: true },
    })) as JneCandidateRow[];

    const summary = resolveDistrictCandidates(internal, rows);

    console.log(`city: ${opts.city}`);
    console.log(`internal districts: ${summary.districts}   JNE candidate pool: ${rows.length}`);
    console.log(
      `REVIEW_REQUIRED=${summary.reviewRequired} AMBIGUOUS=${summary.ambiguous} ` +
        `NOT_FOUND=${summary.notFound} MATCHED=${summary.matched}`,
    );
    console.log(`EXACT_NAME=${summary.exactName} REVIEWED_ALIAS=${summary.reviewedAlias}\n`);
    console.log(formatCandidates(summary.candidates));

    if (opts.dryRun) {
      console.log('\n--dry-run: nothing written.');
      return 0;
    }

    let written = 0;
    for (const c of summary.candidates) {
      // A candidate with no single JNE row has nothing to point at; it is
      // reported above but not persisted, because the mapping row requires a
      // jneLocationId and inventing one would defeat the whole design.
      if (!c.jneLocationId) continue;
      await prisma.jneDistrictMapping.upsert({
        where: { districtId_jneLocationId: { districtId: c.district.id, jneLocationId: c.jneLocationId } },
        create: {
          districtId: c.district.id,
          jneLocationId: c.jneLocationId,
          status: c.status,
          method: c.method,
          confidence: c.confidence,
          evidence: c.evidence as unknown as object,
          notes: c.reason,
        },
        update: {
          // An existing MATCHED row is never demoted by re-running generation.
          method: c.method,
          confidence: c.confidence,
          evidence: c.evidence as unknown as object,
          notes: c.reason,
        },
      });
      written += 1;
    }

    const counts = await prisma.jneDistrictMapping.groupBy({ by: ['status'], _count: { _all: true } });
    console.log(`\nwrote ${written} candidate row(s).`);
    for (const c of counts) console.log(`  ${c.status}: ${c._count._all}`);
    console.log('\nAll candidates are REVIEW_REQUIRED. Approval is a separate --approve run.');
    return 0;
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
