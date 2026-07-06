/**
 * Curated Indonesian administrative master data (Kemendagri / Permendagri codes).
 *
 * This is a REAL but PARTIAL sample: all 38 provinces are present, and a set of
 * cities/districts/villages is populated for realistic chain-select coverage —
 * including the canonical Bandung example (Jawa Barat → Kota Bandung → Coblong →
 * Cipaganti/Lebakgede/Sekeloa/Dago with postal codes).
 *
 * For production, drop the full official dataset (e.g. emsifa/wilayah.id /
 * Kemendagri) into `prisma/data/regions.full.json` — the seeder prefers that file
 * when present and falls back to this sample otherwise. The seeder is idempotent
 * (upsert on `code`), so re-running or swapping in the full dataset never
 * duplicates rows.
 */

export type VillageSeed = { code: string; name: string; postalCode: string };
export type DistrictSeed = { code: string; name: string; villages: VillageSeed[] };
export type CitySeed = {
  code: string;
  name: string;
  type: 'CITY' | 'REGENCY';
  districts: DistrictSeed[];
};
export type ProvinceSeed = { code: string; name: string; cities: CitySeed[] };

export const PROVINCES: ProvinceSeed[] = [
  { code: '11', name: 'Aceh', cities: [] },
  { code: '12', name: 'Sumatera Utara', cities: [] },
  { code: '13', name: 'Sumatera Barat', cities: [] },
  { code: '14', name: 'Riau', cities: [] },
  { code: '15', name: 'Jambi', cities: [] },
  { code: '16', name: 'Sumatera Selatan', cities: [] },
  { code: '17', name: 'Bengkulu', cities: [] },
  { code: '18', name: 'Lampung', cities: [] },
  { code: '19', name: 'Kepulauan Bangka Belitung', cities: [] },
  { code: '21', name: 'Kepulauan Riau', cities: [] },
  {
    code: '31',
    name: 'DKI Jakarta',
    cities: [
      {
        code: '31.74',
        name: 'Kota Jakarta Selatan',
        type: 'CITY',
        districts: [
          {
            code: '31.74.06',
            name: 'Kebayoran Baru',
            villages: [
              { code: '31.74.06.1001', name: 'Selong', postalCode: '12110' },
              { code: '31.74.06.1002', name: 'Gunung', postalCode: '12120' },
              { code: '31.74.06.1003', name: 'Kramat Pela', postalCode: '12130' },
              { code: '31.74.06.1004', name: 'Gandaria Utara', postalCode: '12140' },
              { code: '31.74.06.1005', name: 'Cipete Utara', postalCode: '12150' },
              { code: '31.74.06.1006', name: 'Melawai', postalCode: '12160' },
              { code: '31.74.06.1007', name: 'Petogogan', postalCode: '12170' },
              { code: '31.74.06.1008', name: 'Rawa Barat', postalCode: '12180' },
              { code: '31.74.06.1009', name: 'Senayan', postalCode: '12190' },
            ],
          },
        ],
      },
    ],
  },
  {
    code: '32',
    name: 'Jawa Barat',
    cities: [
      {
        code: '32.73',
        name: 'Kota Bandung',
        type: 'CITY',
        districts: [
          {
            code: '32.73.09',
            name: 'Coblong',
            villages: [
              { code: '32.73.09.1001', name: 'Cipaganti', postalCode: '40131' },
              { code: '32.73.09.1002', name: 'Lebakgede', postalCode: '40132' },
              { code: '32.73.09.1003', name: 'Sadang Serang', postalCode: '40134' },
              { code: '32.73.09.1004', name: 'Sekeloa', postalCode: '40134' },
              { code: '32.73.09.1005', name: 'Dago', postalCode: '40135' },
            ],
          },
          {
            code: '32.73.06',
            name: 'Sukajadi',
            villages: [
              { code: '32.73.06.1001', name: 'Pasteur', postalCode: '40161' },
              { code: '32.73.06.1002', name: 'Sukabungah', postalCode: '40162' },
              { code: '32.73.06.1003', name: 'Cipedes', postalCode: '40162' },
              { code: '32.73.06.1004', name: 'Sukagalih', postalCode: '40163' },
              { code: '32.73.06.1005', name: 'Sukawarna', postalCode: '40164' },
            ],
          },
        ],
      },
      {
        code: '32.04',
        name: 'Kabupaten Bandung',
        type: 'REGENCY',
        districts: [
          {
            code: '32.04.30',
            name: 'Cileunyi',
            villages: [
              { code: '32.04.30.2001', name: 'Cileunyi Kulon', postalCode: '40622' },
              { code: '32.04.30.2002', name: 'Cileunyi Wetan', postalCode: '40623' },
              { code: '32.04.30.2003', name: 'Cimekar', postalCode: '40623' },
              { code: '32.04.30.2004', name: 'Cinunuk', postalCode: '40624' },
              { code: '32.04.30.2005', name: 'Cibiru Wetan', postalCode: '40625' },
            ],
          },
        ],
      },
    ],
  },
  { code: '33', name: 'Jawa Tengah', cities: [] },
  { code: '34', name: 'DI Yogyakarta', cities: [] },
  {
    code: '35',
    name: 'Jawa Timur',
    cities: [
      {
        code: '35.78',
        name: 'Kota Surabaya',
        type: 'CITY',
        districts: [
          {
            code: '35.78.08',
            name: 'Genteng',
            villages: [
              { code: '35.78.08.1001', name: 'Embong Kaliasin', postalCode: '60271' },
              { code: '35.78.08.1002', name: 'Ketabang', postalCode: '60272' },
              { code: '35.78.08.1003', name: 'Kapasari', postalCode: '60272' },
              { code: '35.78.08.1004', name: 'Peneleh', postalCode: '60274' },
              { code: '35.78.08.1005', name: 'Genteng', postalCode: '60275' },
            ],
          },
        ],
      },
    ],
  },
  { code: '36', name: 'Banten', cities: [] },
  { code: '51', name: 'Bali', cities: [] },
  { code: '52', name: 'Nusa Tenggara Barat', cities: [] },
  { code: '53', name: 'Nusa Tenggara Timur', cities: [] },
  { code: '61', name: 'Kalimantan Barat', cities: [] },
  { code: '62', name: 'Kalimantan Tengah', cities: [] },
  { code: '63', name: 'Kalimantan Selatan', cities: [] },
  { code: '64', name: 'Kalimantan Timur', cities: [] },
  { code: '65', name: 'Kalimantan Utara', cities: [] },
  { code: '71', name: 'Sulawesi Utara', cities: [] },
  { code: '72', name: 'Sulawesi Tengah', cities: [] },
  { code: '73', name: 'Sulawesi Selatan', cities: [] },
  { code: '74', name: 'Sulawesi Tenggara', cities: [] },
  { code: '75', name: 'Gorontalo', cities: [] },
  { code: '76', name: 'Sulawesi Barat', cities: [] },
  { code: '81', name: 'Maluku', cities: [] },
  { code: '82', name: 'Maluku Utara', cities: [] },
  { code: '91', name: 'Papua', cities: [] },
  { code: '92', name: 'Papua Barat', cities: [] },
  { code: '93', name: 'Papua Selatan', cities: [] },
  { code: '94', name: 'Papua Tengah', cities: [] },
  { code: '95', name: 'Papua Pegunungan', cities: [] },
  { code: '96', name: 'Papua Barat Daya', cities: [] },
];
