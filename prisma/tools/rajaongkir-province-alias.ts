/**
 * PAXELBOX-51: Massular (Kemendagri) province name -> RajaOngkir province name.
 *
 * Curated DATA, reviewed by a human — never a normalisation rule. The mapper's
 * normaliser deliberately preserves parentheses and does not expand
 * abbreviations, so `NUSA TENGGARA BARAT (NTB)` and `Nusa Tenggara Barat` do not
 * match on their own. Fixing that with a stripping rule would also silently
 * merge names nobody checked; an alias is one reviewed decision instead.
 *
 * ---------------------------------------------------------------------------
 * CONFIDENCE IS EXPLICIT, AND NOTHING IS CONFIRMED YET
 *
 * Every entry below is REVIEW_REQUIRED. They were derived in PAXELBOX-50 by
 * comparing two name lists — Massular's 38 provinces against RajaOngkir's 34 —
 * which is a reading, not a verification. `confirmedAliases()` returns only
 * CONFIRMED entries, so nothing here reaches a mapping run until an operator
 * promotes it.
 *
 * 28 provinces match exactly and need no entry at all.
 */

export type AliasConfidence = 'CONFIRMED' | 'REVIEW_REQUIRED' | 'NO_COVERAGE';

export interface ProvinceAlias {
  /** Kemendagri province name, exactly as stored in the Province master. */
  massular: string;
  /** RajaOngkir's `province_name`, or null when it has no such province. */
  rajaOngkir: string | null;
  confidence: AliasConfidence;
  note: string;
}

export const PROVINCE_ALIASES: ProvinceAlias[] = [
  {
    massular: 'Aceh',
    rajaOngkir: 'NANGGROE ACEH DARUSSALAM (NAD)',
    confidence: 'REVIEW_REQUIRED',
    note: 'RajaOngkir uses the pre-2009 official name plus an abbreviation in parentheses.',
  },
  {
    massular: 'Daerah Istimewa Yogyakarta',
    rajaOngkir: 'DI YOGYAKARTA',
    confidence: 'REVIEW_REQUIRED',
    note: 'Abbreviated form of the same province.',
  },
  {
    massular: 'Daerah Khusus Ibukota Jakarta',
    rajaOngkir: 'DKI JAKARTA',
    confidence: 'REVIEW_REQUIRED',
    note: 'Abbreviated form of the same province.',
  },
  {
    massular: 'Nusa Tenggara Barat',
    rajaOngkir: 'NUSA TENGGARA BARAT (NTB)',
    confidence: 'REVIEW_REQUIRED',
    note: 'Same name with a parenthesised abbreviation the normaliser preserves.',
  },
  {
    massular: 'Nusa Tenggara Timur',
    rajaOngkir: 'NUSA TENGGARA TIMUR (NTT)',
    confidence: 'REVIEW_REQUIRED',
    note: 'Same name with a parenthesised abbreviation the normaliser preserves.',
  },
  {
    massular: 'Kepulauan Bangka Belitung',
    rajaOngkir: 'BANGKA BELITUNG',
    confidence: 'REVIEW_REQUIRED',
    note: 'RajaOngkir omits the "Kepulauan" prefix.',
  },

  // The four provinces created in 2022. RajaOngkir listed 34 provinces in
  // PAXELBOX-41A and none of these appeared, so addresses there can have no
  // RajaOngkir identity and will yield no JNE quote under any strategy.
  { massular: 'Papua Tengah', rajaOngkir: null, confidence: 'NO_COVERAGE', note: 'Created 2022; absent from the observed RajaOngkir province list.' },
  { massular: 'Papua Selatan', rajaOngkir: null, confidence: 'NO_COVERAGE', note: 'Created 2022; absent from the observed RajaOngkir province list.' },
  { massular: 'Papua Pegunungan', rajaOngkir: null, confidence: 'NO_COVERAGE', note: 'Created 2022; absent from the observed RajaOngkir province list.' },
  { massular: 'Papua Barat Daya', rajaOngkir: null, confidence: 'NO_COVERAGE', note: 'Created 2022; absent from the observed RajaOngkir province list.' },
];

/**
 * The alias map the mapper may actually use — CONFIRMED entries only.
 *
 * Today that is deliberately EMPTY: promoting an alias is an operator decision,
 * and an unreviewed guess about a province would mis-map every address in it.
 */
export function confirmedAliases(aliases: ProvinceAlias[] = PROVINCE_ALIASES): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of aliases) {
    if (a.confidence === 'CONFIRMED' && a.rajaOngkir) out[a.massular] = a.rajaOngkir;
  }
  return out;
}

/** Provinces RajaOngkir cannot serve at all — their villages stay unmapped. */
export function noCoverageProvinces(aliases: ProvinceAlias[] = PROVINCE_ALIASES): string[] {
  return aliases.filter((a) => a.confidence === 'NO_COVERAGE').map((a) => a.massular);
}

/** Entries still awaiting a human decision. */
export function pendingReview(aliases: ProvinceAlias[] = PROVINCE_ALIASES): ProvinceAlias[] {
  return aliases.filter((a) => a.confidence === 'REVIEW_REQUIRED');
}
