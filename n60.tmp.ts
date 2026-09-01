/** PAXELBOX-60N offline expansion planning. READ-ONLY. Temporary. */
import * as fs from 'node:fs';

import { poolFrom, type AcquiredUnit } from './prisma/tools/rajaongkir-acquisition';
import { createFileStorage } from './prisma/tools/rajaongkir-storage';
import { buildSearchPlan, VALIDATED_VILLAGE_TOKENS, isGenericToken } from './prisma/tools/rajaongkir-plan';
import { confirmedAliases } from './prisma/tools/rajaongkir-province-alias';
import { aliasTables } from './prisma/tools/rajaongkir-alias';
import { mapVillages, normalizeName } from './prisma/tools/rajaongkir-village-map';
import { parseVillages, reconstructAcquiredUnits } from './prisma/tools/rajaongkir-acquire';

const R = 'prisma/data/rajaongkir-cache/full-kota-bandung';
const z = (v: string | null | undefined) => (v ?? '').replace(/\D/g, '') || null;

(async () => {
  const cp = JSON.parse(fs.readFileSync(`${R}/checkpoint.json`, 'utf8'));
  const villages = parseVillages(JSON.parse(fs.readFileSync(`${R}/../kota-bandung-villages.json`, 'utf8')));
  const units: AcquiredUnit[] = await reconstructAcquiredUnits(createFileStorage(R), cp.completedUnits);
  const rows = units.flatMap((u) => u.rows);
  const pool = poolFrom(units);
  const report = mapVillages(villages, pool, { province: confirmedAliases(), ...aliasTables() });
  const outcome = new Map(report.matches.map((m) => [m.code, m]));
  const plan = buildSearchPlan(villages);

  // ---------------- PART 1
  const stored = JSON.parse(fs.readFileSync(`${R}/mapping-report.json`, 'utf8')).report;
  console.log('=== PART 1: reconstruction ===');
  console.log(`  villages=${villages.length}  MATCHED=${report.matched}  NOT_FOUND=${report.notFound}  AMBIGUOUS=${report.ambiguous}  REVIEW_REQUIRED=${report.reviewRequired}`);
  console.log(`  completedUnits=${cp.completedUnits.length}  pool=${pool.length}`);
  const agrees = stored.matched === report.matched && stored.notFound === report.notFound &&
    stored.ambiguous === report.ambiguous && stored.reviewRequired === report.reviewRequired;
  console.log(`  agrees with mapping-report.json: ${agrees ? 'YES' : 'NO *** STOP ***'}`);

  // ---------------- indexes
  const searched = new Set(units.map((u) => normalizeName(u.searchTerm)));
  const districtSearched = (d: string) => searched.has(normalizeName(d));
  const unitFor = (d: string) => units.find((u) => normalizeName(u.searchTerm) === normalizeName(d));
  const roByDistrict = (d: string) => rows.filter((r) => normalizeName(r.district_name) === normalizeName(d));

  type Cause =
    | 'DISTRICT_NEVER_SEARCHED' | 'DISTRICT_ZERO_ROWS' | 'DISTRICT_NAME_MISMATCH'
    | 'VILLAGE_NAME_MISMATCH' | 'POSTAL_MISMATCH' | 'MEMBERSHIP_CONFLICT' | 'UNKNOWN';
  type TokenClass = 'MEASURED' | 'PROPOSABLE' | 'ADVERSE' | 'IMPOSSIBLE';

  interface Row {
    v: (typeof villages)[number]; cause: Cause; tok: TokenClass; term: string | null;
    evidence: string; indirect: string;
  }
  const measured = new Set(VALIDATED_VILLAGE_TOKENS.map((t) => normalizeName(t.searchTerm)));

  const notFound = villages.filter((v) => outcome.get(v.code)!.outcome === 'NOT_FOUND');
  const results: Row[] = [];

  for (const v of notFound) {
    const nameTok = v.name.trim().split(/\s+/);
    const single = nameTok.length === 1;

    // ---- root cause
    let cause: Cause = 'UNKNOWN';
    let indirect = '';
    if (!districtSearched(v.districtName)) cause = 'DISTRICT_NEVER_SEARCHED';
    else if ((unitFor(v.districtName)?.rows.length ?? 0) === 0) cause = 'DISTRICT_ZERO_ROWS';
    else if (roByDistrict(v.districtName).length === 0) cause = 'DISTRICT_NAME_MISMATCH';
    else {
      const here = roByDistrict(v.districtName);
      const exact = here.find((r) => normalizeName(r.subdistrict_name) === normalizeName(v.name));
      if (exact) cause = z(exact.zip_code) === z(v.postalCode) ? 'UNKNOWN' : 'POSTAL_MISMATCH';
      else cause = 'VILLAGE_NAME_MISMATCH';
    }
    // membership conflict: our village name exists in RO under a DIFFERENT district
    const elsewhere = rows.filter(
      (r) => normalizeName(r.subdistrict_name) === normalizeName(v.name) &&
        normalizeName(r.district_name) !== normalizeName(v.districtName),
    );
    if (elsewhere.length > 0) {
      indirect = elsewhere
        .map((r) => `id ${r.id} under ${r.district_name} @${r.zip_code} (ours @${v.postalCode}; zip ${z(r.zip_code) === z(v.postalCode) ? 'MATCHES' : 'differs'})`)
        .join(' ; ');
      if (cause === 'DISTRICT_NEVER_SEARCHED' || cause === 'VILLAGE_NAME_MISMATCH') cause = 'MEMBERSHIP_CONFLICT';
    }

    // ---- token class
    let tok: TokenClass; let term: string | null = null; let ev = '';
    if (measured.has(normalizeName(v.name))) { tok = 'MEASURED'; term = v.name; ev = 'PAXELBOX-60K/60M direct measurement'; }
    else if (!single) { tok = 'IMPOSSIBLE'; ev = `village name is ${nameTok.length} tokens; no single-token candidate`; }
    else if (isGenericToken(v.name)) { tok = 'IMPOSSIBLE'; ev = 'name is a generic administrative token'; }
    else if (elsewhere.length > 0) {
      tok = 'ADVERSE'; term = v.name;
      ev = `name already observed in acquired rows under another district: ${elsewhere.map((r) => r.district_name + '@' + r.zip_code).join(', ')}`;
    } else { tok = 'PROPOSABLE'; term = v.name; ev = 'single, non-generic token with no adverse evidence in acquired rows'; }

    results.push({ v, cause, tok, term, evidence: ev, indirect });
  }

  // ---------------- PART 2
  console.log(`\n=== PART 2: exhaustive NOT_FOUND inventory (${notFound.length}) ===`);
  console.log('district           village                   postal  searched roRows cause                     token');
  for (const r of results.sort((a, b) => a.v.districtName.localeCompare(b.v.districtName) || a.v.name.localeCompare(b.v.name))) {
    const u = unitFor(r.v.districtName);
    console.log(
      r.v.districtName.padEnd(19) + r.v.name.padEnd(26) + String(r.v.postalCode).padEnd(8) +
      (districtSearched(r.v.districtName) ? 'yes' : 'NO ').padEnd(9) +
      String(u ? u.rows.length : '-').padStart(5) + '  ' + r.cause.padEnd(24) + ' ' + r.tok,
    );
  }

  // ---------------- PART 3/6 counts
  console.log('\n=== PART 3/6: root-cause counts ===');
  const causeCount = new Map<string, number>();
  for (const r of results) causeCount.set(r.cause, (causeCount.get(r.cause) ?? 0) + 1);
  for (const [c, n] of [...causeCount].sort()) console.log(`  ${c.padEnd(26)} ${n}`);

  console.log('\n=== token classification counts ===');
  const tokCount = new Map<string, number>();
  for (const r of results) tokCount.set(r.tok, (tokCount.get(r.tok) ?? 0) + 1);
  for (const [c, n] of [...tokCount].sort()) console.log(`  ${c.padEnd(12)} ${n}`);

  // ---------------- PART 4/5
  console.log('\n=== PART 4/5: PROPOSABLE tokens (term = village name verbatim; NOT executable) ===');
  for (const r of results.filter((x) => x.tok === 'PROPOSABLE').sort((a, b) => a.v.districtName.localeCompare(b.v.districtName))) {
    console.log(`  ${r.v.districtName.padEnd(19)} ${r.v.name.padEnd(22)} -> search="${r.term}"  zip=${r.v.postalCode}`);
  }
  console.log('\n=== ADVERSE tokens ===');
  for (const r of results.filter((x) => x.tok === 'ADVERSE')) {
    console.log(`  ${r.v.districtName} / ${r.v.name}: ${r.evidence}`);
  }
  console.log('\n=== IMPOSSIBLE (no safe single token) ===');
  for (const r of results.filter((x) => x.tok === 'IMPOSSIBLE')) {
    console.log(`  ${r.v.districtName.padEnd(19)} ${r.v.name.padEnd(24)} NONE — ${r.evidence}`);
  }

  // ---------------- PART 7
  console.log('\n=== PART 7: indirect hits (RO row exists but matcher rejects) ===');
  const hits = results.filter((r) => r.indirect);
  if (hits.length === 0) console.log('  none');
  for (const r of hits) console.log(`  ${r.v.districtName} / ${r.v.name}: ${r.indirect}`);

  // ---------------- PART 5 breadth evidence
  console.log('\n=== PART 5: token breadth evidence from ACQUIRED artifacts (indirect, never MEASURED) ===');
  for (const u of [...units].sort((a, b) => b.rows.length - a.rows.length).slice(0, 6)) {
    console.log(`  "${u.searchTerm}" -> ${u.rows.length} rows over ${u.offsets.length} page(s)`);
  }
  console.log('  (These are DISTRICT-term searches except Braga. No other village token has been searched.)');

  // ---------------- PART 11 arithmetic
  console.log('\n=== PART 11: completeness arithmetic ===');
  const nf = results.length;
  const byTok = (t: TokenClass) => results.filter((r) => r.tok === t).length;
  const byCause = (c: Cause) => results.filter((r) => r.cause === c).length;
  console.log(`  total villages                         151`);
  console.log(`  MATCHED                                ${report.matched}`);
  console.log(`  REVIEW_REQUIRED (Cinambo postal)       ${report.reviewRequired}`);
  console.log(`  NOT_FOUND                              ${nf}`);
  console.log(`    with a usable single-token candidate ${byTok('PROPOSABLE')}  (PROPOSABLE)`);
  console.log(`    with adverse token evidence          ${byTok('ADVERSE')}`);
  console.log(`    with NO usable single token          ${byTok('IMPOSSIBLE')}`);
  console.log(`    already measured                     ${byTok('MEASURED')}`);
  console.log(`  ---- by root cause ----`);
  for (const c of ['DISTRICT_NEVER_SEARCHED','DISTRICT_ZERO_ROWS','DISTRICT_NAME_MISMATCH','VILLAGE_NAME_MISMATCH','POSTAL_MISMATCH','MEMBERSHIP_CONFLICT','UNKNOWN'] as Cause[]) {
    const n = byCause(c); if (n) console.log(`    ${c.padEnd(26)} ${n}`);
  }
  console.log(`  check: ${report.matched} + ${report.reviewRequired} + ${nf} = ${report.matched + report.reviewRequired + nf}`);
  console.log(`  ceiling if EVERY proposable token were validated and matched: ${report.matched + byTok('PROPOSABLE')} / 151`);

  console.log(`\n  planner today: districts=${plan.districts} executable=${plan.units.length} review=${plan.review.length} villageTokens=${plan.villageTokenUnits.length}`);
})().catch((e) => { console.error('FAILED: ' + (e instanceof Error ? e.message : String(e))); process.exit(1); });
