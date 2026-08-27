# RajaOngkir District Mapping — Validation Report (PAXELBOX-41A)

**Verdict: BLOCKED.** The approved Option E matching strategy (exact
`province + city + district`) cannot work against the real RajaOngkir dataset.

## A. Dataset timestamp
Fetched 2026-08-27. Sample only — a full sweep was deliberately **not** performed
once the hierarchy mismatch below was proven, to avoid spending an unpublished
quota on a design that must change.

## B. API contract used (verified live, read-only)
```
Base : https://rajaongkir.komerce.id/api/v1
Auth : header  key: <API_KEY>          (200 with key, 401 without — key is ACTIVE)
GET /destination/province
GET /destination/city/{province_id}
GET /destination/district/{city_id}
Envelope: { meta: { message, code, status }, data: [...] }
```
No cost endpoint was called. No writes of any kind.

## C. Total counts

| Level | Massular (Kemendagri) | RajaOngkir |
|---|---|---|
| Provinces | **38** | **34** |
| Cities (10 sampled provinces) | **218** | **198** |
| Districts | 7,285 | not fully enumerated |

10 Massular provinces have **no exact RO name match**: Aceh, Daerah Istimewa
Yogyakarta, Daerah Khusus Ibukota Jakarta, Kepulauan Bangka Belitung, Nusa
Tenggara Barat, Nusa Tenggara Timur, Papua Barat Daya, Papua Pegunungan, and two
more. Two distinct causes:
- **Naming**: RO uses `NANGGROE ACEH DARUSSALAM (NAD)`, `DI YOGYAKARTA`,
  `NUSA TENGGARA BARAT (NTB)`, `BANGKA BELITUNG`.
- **Coverage**: the four provinces created in 2022 (Papua Selatan, Papua Tengah,
  Papua Pegunungan, Papua Barat Daya) are **absent** from RajaOngkir entirely.

## D. Aggregate rows — the `zip_code` rule is inert

PAXELBOX-41 excluded rows with `zip_code === "0"`, based on a documented sample.
**In practice the field is not returned at all.** All 20 sampled district
responses had row keys `id,name` only (`zip_code_field=false`, `zip0=0`).

The `isAggregateRow()` guard therefore never fires against live data. It is not
harmful, but it provides none of the protection it was written for.

## E. Terminology analysis — **NOT CONFIRMED**

| RajaOngkir level | Kemendagri level | Conclusion |
|---|---|---|
| Province | Province | **Partially** — 34 vs 38, 10 name mismatches |
| **City** | **City (Kota/Kabupaten)** | **NOT CONFIRMED — RO merges Kota + Kabupaten into one "city"** |
| District | District (kecamatan) | **Plausible** — but nested under a different city concept |
| Subdistrict | Village (kelurahan/desa) | not investigated (out of scope) |

### Proof — Cirebon
```
Massular : 32.74 Kota Cirebon        5 kecamatan
           32.09 Kabupaten Cirebon  40 kecamatan
RajaOngkir: city #129 "CIREBON"     45 districts   (= 5 + 40)
  matches Kota Cirebon      : 5 / 5
  matches Kabupaten Cirebon : 36 / 40
```
One RO city spans **two** Kemendagri cities.

### Proof — Bandung (worst observed)
RO city #55 `BANDUNG` (62 districts) spans **10** Kemendagri cities:
Kota Bandung 26/30, Kabupaten Bandung 28/31, plus 1–2 stray name collisions in
Karawang, Sukabumi, Majalengka, Subang, Garut, Cianjur, Purwakarta, Sumedang.

## F. Sample — 10 provinces / 20 cities

**9 of 20 sampled RO cities span more than one Kemendagri city.**

| Province | RO city | RO districts | Spans |
|---|---|---|---|
| Jawa Barat | BANDUNG | 62 | **10 cities** |
| Jawa Barat | CIMAHI | 3 | 1 (Kota Cimahi 3/3) |
| Jawa Tengah | CILACAP | 24 | 1 (Kab. Cilacap 24/24) |
| Jawa Tengah | MAGELANG | 24 | **3** (Kota 3/3, Kab. 21/21, Purworejo 1) |
| Jawa Timur | JEMBER | 31 | **4** |
| Jawa Timur | BANYUWANGI | 25 | **3** |
| Bali | DENPASAR | 4 | 1 (4/4) |
| Bali | KARANGASEM | 8 | 1 (7/8) |
| Sumatera Utara | TOBA SAMOSIR | 16 | 1 (15/16) |
| Sumatera Utara | GUNUNGSITOLI | 6 | 1 (6/6) |
| Sumatera Barat | PADANG | 11 | 1 (11/11) |
| Sumatera Barat | TANAH DATAR | 14 | 1 (11/14) |
| Kalimantan Timur | BALIKPAPAN | 6 | 1 (6/6) |
| Kalimantan Timur | KUTAI KARTANEGARA | 18 | 1 (17/20) |
| Sulawesi Selatan | MAKASSAR | 14 | 1 (13/15) |
| Sulawesi Selatan | BANTAENG | 8 | **3** |
| Banten | CILEGON | 8 | **2** |
| Banten | PANDEGLANG | 35 | **2** |
| Lampung | BANDAR LAMPUNG | 20 | **2** |
| Lampung | LAMPUNG SELATAN | 17 | **2** |

## G. Mapping statistics
**Not produced.** Running the PAXELBOX-41 mapper over this data would report
near-total `NOT_FOUND`, because it requires the RO city name to equal the
Kemendagri city name — which is false by construction for merged cities, and for
all 10 mismatched provinces. The number would measure the design flaw, not the data.

## H/I. Ambiguity and NOT_FOUND examples
- **Ambiguity**: `BANDUNG` contains kecamatan belonging to 10 different Kemendagri
  cities. Kecamatan names repeat across cities nationwide, so district-name
  matching within a province is not safe either.
- **NOT_FOUND**: even inside a correctly identified city, exact name matching
  misses 10–20 % of kecamatan — Kota Bandung 26/30, Kab. Bandung 28/31,
  Makassar 13/15, Toba 15/16, Tanah Datar 11/14, Kutai Kartanegara 17/20.

## J. Duplicate mapping analysis
Not reached. The city-level mismatch must be resolved first; duplicate analysis
on a broken join would be meaningless.

## K. Recommendation

The Option E *storage* decision (one nullable `District.rajaOngkirId`) remains
sound — it is the *matching* step that is blocked. Three ways forward, none
implemented, none chosen:

1. **Two-stage match keyed on district, disambiguated by city.** Match RO
   districts to Kemendagri kecamatan within a *province*, then use the Kemendagri
   city only to break ties. Handles merged cities; needs a rule for the ~10–20 %
   name misses and for repeated kecamatan names.
2. **Curated province + city alias table.** Maps `NANGGROE ACEH DARUSSALAM (NAD)`
   → `Aceh`, and each RO merged city → its set of Kemendagri cities. Deterministic
   and reviewable, but a hand-maintained artifact.
3. **Accept partial coverage.** Map only the unambiguous cities (11 of 20 sampled
   were clean 1:1) and leave the rest NULL — no JNE quote there.

**Four Papua provinces have no RajaOngkir coverage at all** under any option.

## Safety
No cost-endpoint call, no DB write, migration still unapplied, `.env` untouched,
API key never written to this file or any log.
