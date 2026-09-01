/**
 * PAXELBOX-60I: the Kota Bandung district/village aliases APPROVED BY AN
 * OPERATOR in PAXELBOX-60H.
 *
 * ---------------------------------------------------------------------------
 * THIS FILE IS DATA, NOT A RULE
 *
 * Every entry was reviewed individually against eight conditions before it was
 * approved: same province, same city, same district context, same postal code,
 * a unique RajaOngkir candidate, no competing destination id, no
 * district-membership anomaly, and an explainable transformation. The
 * destination id and postal code that justified each one are recorded here so a
 * later reader can re-check the decision instead of trusting the name pair.
 *
 * Nothing here is derived. There is no edit distance, no phonetic rule and no
 * "names look close enough" heuristic anywhere in this module — those were
 * rejected precisely because `BABAKAN` matched 79 of 96 rows in PAXELBOX-60D
 * and `SUKAMAJU`/`NEGLASARI` name-collide with places 200 km away.
 *
 * ---------------------------------------------------------------------------
 * AN ALIAS CANNOT MANUFACTURE A MATCH
 *
 * An alias only changes which candidates a village GATHERS. The postal code
 * still decides between them, and AMBIGUOUS still blocks. So an approved alias
 * whose postal evidence later stops agreeing degrades to REVIEW_REQUIRED rather
 * than silently binding the wrong destination.
 *
 * ---------------------------------------------------------------------------
 * DELIBERATELY ABSENT
 *
 *   Cinambo (4 villages)  postal 40296 vs 40294 — an unresolved data conflict,
 *                         left REVIEW_REQUIRED pending a business decision.
 *   SINDANG JAYA, CICADAS, NEGLASARI, SUKAMAJU
 *                         same name, different place; postal codes disagree,
 *                         two of them outside Bandung entirely.
 *   Astanaanyar           RajaOngkir returned zero rows; its spelling is
 *                         unknown, so there is nothing to alias TO.
 *   Ujungberung           RajaOngkir's own district was not in the result set.
 */

import { normalizeName, type MassularVillage } from './rajaongkir-village-map';

export type AliasKind = 'DISTRICT' | 'VILLAGE';

export interface ApprovedAlias {
  kind: AliasKind;
  /** Massular value, exactly as stored in the master. */
  massular: string;
  /** RajaOngkir's spelling, exactly as returned by the API. */
  rajaOngkir: string;
  /** For a VILLAGE alias, the Massular district that scopes it. */
  districtContext?: string;
  /** The destination id(s) this alias was approved against. */
  destinationIds: number[];
  /** The postal code both sides agreed on at approval time. */
  postalCode: string;
  note: string;
}

/** Approved by the operator in PAXELBOX-60H. 2 district + 12 village. */
export const KOTA_BANDUNG_ALIASES: ApprovedAlias[] = [
  // --- district -----------------------------------------------------------
  {
    kind: 'DISTRICT',
    massular: 'Antapani',
    rajaOngkir: 'ANTAPANI (CICADAS)',
    destinationIds: [4830, 4831, 4832, 4833],
    postalCode: '40291',
    note: 'RajaOngkir appends the historic name CICADAS. All four village names and postal codes agree exactly.',
  },
  {
    kind: 'DISTRICT',
    massular: 'Buahbatu',
    rajaOngkir: 'BUAHBATU (MARGACINTA)',
    destinationIds: [4928, 4929, 4930, 4931],
    postalCode: '40286',
    note: 'RajaOngkir appends the historic name MARGACINTA. Unlocks Sekejati and Margasari alone; Jati Sari and Cijaura need their village aliases too.',
  },

  // --- village ------------------------------------------------------------
  { kind: 'VILLAGE', massular: 'Gegerkalong', rajaOngkir: 'GEGER KALONG', districtContext: 'Sukasari', destinationIds: [4826], postalCode: '40153', note: 'spacing only' },
  { kind: 'VILLAGE', massular: 'Husein Sastranegara', rajaOngkir: 'HUSEN SASTRANEGARA', districtContext: 'Cicendo', destinationIds: [4911], postalCode: '40174', note: 'Husein -> HUSEN' },
  { kind: 'VILLAGE', massular: 'Pasirkaliki', rajaOngkir: 'PASIR KALIKI', districtContext: 'Cicendo', destinationIds: [4914], postalCode: '40171', note: 'spacing only' },
  { kind: 'VILLAGE', massular: 'Kebon Waru', rajaOngkir: 'KEBONWARU', districtContext: 'Batununggal', destinationIds: [4886], postalCode: '40272', note: 'spacing only' },
  { kind: 'VILLAGE', massular: 'Kebon Jayanti', rajaOngkir: 'KEBUN JAYANTI', districtContext: 'Kiaracondong', destinationIds: [4926], postalCode: '40281', note: 'Kebon -> KEBUN' },
  { kind: 'VILLAGE', massular: 'Derwati', rajaOngkir: 'DARWATI', districtContext: 'Rancasari', destinationIds: [4933], postalCode: '40292', note: 'single letter e -> a' },
  { kind: 'VILLAGE', massular: 'Cisaranten Bina Harapan', rajaOngkir: 'CISARENTEN BINA HARAPAN', districtContext: 'Arcamanik', destinationIds: [4851], postalCode: '40294', note: 'SARAN -> SAREN' },
  { kind: 'VILLAGE', massular: 'Pasir Biru', rajaOngkir: 'PASIRBIRU', districtContext: 'Cibiru', destinationIds: [4820], postalCode: '40615', note: 'spacing only' },
  { kind: 'VILLAGE', massular: 'Rancabolang', rajaOngkir: 'RANCABALONG', districtContext: 'Gedebage', destinationIds: [4958], postalCode: '40294', note: 'BOLANG -> BALONG' },
  { kind: 'VILLAGE', massular: 'Mekar Mulya', rajaOngkir: 'MEKARMULYA', districtContext: 'Panyileukan', destinationIds: [4967], postalCode: '40614', note: 'spacing only' },
  { kind: 'VILLAGE', massular: 'Jati Sari', rajaOngkir: 'JATISARI', districtContext: 'Buahbatu', destinationIds: [4929], postalCode: '40286', note: 'spacing only; also needs the Buahbatu district alias' },
  { kind: 'VILLAGE', massular: 'Cijaura', rajaOngkir: 'CIJAURA (MARGASENANG)', districtContext: 'Buahbatu', destinationIds: [4928], postalCode: '40287', note: 'RajaOngkir appends the historic name MARGASENANG; also needs the Buahbatu district alias' },
];

/**
 * Alias lookup tables the matcher consumes.
 *
 * Village aliases are keyed by DISTRICT + VILLAGE, never by village name alone.
 * Village names repeat across Indonesia — a bare-name alias would silently
 * rewrite a same-named village in a district nobody reviewed.
 */
export interface AliasTables {
  province?: Record<string, string>;
  district?: Record<string, string>;
  /** Keys built with `villageAliasKey(district, village)`. */
  village?: Record<string, string>;
}

export function villageAliasKey(districtName: string, villageName: string): string {
  return `${normalizeName(districtName)}|${normalizeName(villageName)}`;
}

/** Build the tables from approved entries. Pure. */
export function aliasTables(entries: ApprovedAlias[] = KOTA_BANDUNG_ALIASES): AliasTables {
  const district: Record<string, string> = {};
  const village: Record<string, string> = {};
  for (const a of entries) {
    if (a.kind === 'DISTRICT') {
      district[a.massular] = a.rajaOngkir;
      continue;
    }
    if (!a.districtContext) {
      // A village alias with no district is unscoped and therefore unsafe.
      throw new Error(`village alias "${a.massular}" has no districtContext`);
    }
    village[villageAliasKey(a.districtContext, a.massular)] = a.rajaOngkir;
  }
  return { district, village };
}

/** Villages an alias is expected to affect — used by the regression report. */
export function affectedVillages(villages: MassularVillage[], entries: ApprovedAlias[] = KOTA_BANDUNG_ALIASES): MassularVillage[] {
  const districts = new Set(entries.filter((a) => a.kind === 'DISTRICT').map((a) => normalizeName(a.massular)));
  const villageKeys = new Set(
    entries.filter((a) => a.kind === 'VILLAGE').map((a) => villageAliasKey(a.districtContext!, a.massular)),
  );
  return villages.filter(
    (v) => districts.has(normalizeName(v.districtName)) || villageKeys.has(villageAliasKey(v.districtName, v.name)),
  );
}
