import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { ShippingService } from '../shipping/shipping.service';
import { ShippingQuote } from '../shipping/domain/shipping-provider.interface';
import { selectPaxelBox } from '../shipping/domain/paxel-box';
import { DeliveryCoverageService } from '../delivery-coverage/delivery-coverage.service';

export interface AllocationItem {
  productId: string;
  quantity: number;
}

export interface AllocationAddress {
  provinceId: string | null;
  cityId: string | null;
  districtId: string | null;
  villageId: string | null;
  postalCode: string | null;
  latitude: unknown;
  longitude: unknown;
  // Master-address NAMES, forwarded to couriers that price on place names
  // rather than postal codes (Paxel). Optional: coverage and scoring never
  // read them, so existing callers stay valid.
  address?: string | null;
  province?: string | null;
  city?: string | null;
  district?: string | null;
  village?: string | null;
}

/** Region names carried with an outlet so a rate request can be built from it. */
export interface OutletRegionNames {
  address?: string | null;
  province?: string | null;
  city?: string | null;
  district?: string | null;
  village?: string | null;
}

export interface AllocationResult {
  outletId: string | null;
  outlet:
    | ({ id: string; name: string; postalCode: string | null; latitude: number | null; longitude: number | null } & OutletRegionNames)
    | null;
  quotes: ShippingQuote[];
  score: number;
  usedFallback: boolean;
}

// Scoring weights (must sum to 1). Lower normalized value = better for the first
// three; remaining stock is inverted so more stock scores better.
const W = { distance: 0.4, shipping: 0.3, eta: 0.2, stock: 0.1 };

function toNum(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

/** Names only; ids mean nothing to a courier and nothing else here needs the rows. */
const OUTLET_REGION_NAMES = {
  include: {
    province: { select: { name: true } },
    city: { select: { name: true } },
    district: { select: { name: true } },
    village: { select: { name: true } },
  },
} as const;

interface OutletWithRegions {
  addressDetail: string | null;
  province?: { name: string } | null;
  city?: { name: string } | null;
  district?: { name: string } | null;
  village?: { name: string } | null;
}

/** Region names for a rate request. One place, so both allocation paths agree. */
function regionFields(outlet: OutletWithRegions, address: AllocationAddress) {
  return {
    originAddress: outlet.addressDetail ?? undefined,
    originProvince: outlet.province?.name,
    originCity: outlet.city?.name,
    originDistrict: outlet.district?.name,
    originVillage: outlet.village?.name,
    destinationAddress: address.address ?? undefined,
    destinationProvince: address.province ?? undefined,
    destinationCity: address.city ?? undefined,
    destinationDistrict: address.district ?? undefined,
    destinationVillage: address.village ?? undefined,
  };
}

/** The outlet projection returned to callers, including the names Paxel needs. */
function outletProjection(outlet: OutletWithRegions & { id: string; name: string; postalCode: string | null; latitude: unknown; longitude: unknown }) {
  return {
    id: outlet.id,
    name: outlet.name,
    postalCode: outlet.postalCode,
    latitude: toNum(outlet.latitude),
    longitude: toNum(outlet.longitude),
    address: outlet.addressDetail,
    province: outlet.province?.name ?? null,
    city: outlet.city?.name ?? null,
    district: outlet.district?.name ?? null,
    village: outlet.village?.name ?? null,
  };
}

/** Haversine distance in km (0 when either point lacks coordinates → neutral). */
function distanceKm(aLat: number | null, aLng: number | null, bLat: number | null, bLng: number | null): number {
  if (aLat === null || aLng === null || bLat === null || bLng === null) return 0;
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Parse a courier ETA label ("Today"/"Tomorrow"/"2-3 Days") to a day count. */
function etaDays(label: string): number {
  const l = label.toLowerCase();
  if (l.includes('today')) return 0;
  if (l.includes('tomorrow')) return 1;
  const m = l.match(/\d+/);
  return m ? Number(m[0]) : 3;
}

function normalize(value: number, min: number, max: number): number {
  if (max === min) return 0;
  return (value - min) / (max - min);
}

/**
 * Chooses the single best outlet to fulfil an entire order: filters by delivery
 * coverage and per-outlet stock, quotes shipping from each candidate, and scores
 * distance/shipping/ETA/remaining-stock. Split shipment is not supported — if no
 * one outlet stocks every item, checkout is rejected. Falls back to the active
 * outlet while ProductInventory is still being populated (migration window).
 */
@Injectable()
export class InventoryAllocationService {
  private readonly logger = new Logger('InventoryAllocationService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly shipping: ShippingService,
    @Optional() private readonly coverage?: DeliveryCoverageService,
  ) {}

  async allocate(items: AllocationItem[], address: AllocationAddress, weightGram: number): Promise<AllocationResult> {
    await this.assertCoverage(address);

    const qtyByProduct = new Map<string, number>();
    for (const item of items) qtyByProduct.set(item.productId, (qtyByProduct.get(item.productId) ?? 0) + item.quantity);
    const productIds = [...qtyByProduct.keys()];
    // SUM(OrderItem.quantity) across the whole order — one PaxelBox per order,
    // never per SKU. Same total as summing `items` directly; derived from the
    // map already built above rather than a second pass.
    const totalQuantity = [...qtyByProduct.values()].reduce((sum, qty) => sum + qty, 0);

    // Candidate outlets: active outlets with a ProductInventory row for EVERY item
    // and enough available stock (stock − reserved) at that outlet.
    const inventories = await this.prisma.productInventory.findMany({
      where: { productId: { in: productIds }, outlet: { isActive: true } },
      include: { outlet: { include: OUTLET_REGION_NAMES.include } },
    });

    if (inventories.length === 0) {
      // Migration fallback: no per-outlet inventory yet → use the active outlet.
      return this.fallbackToActiveOutlet(address, weightGram, totalQuantity);
    }

    const byOutlet = new Map<string, typeof inventories>();
    for (const inv of inventories) {
      const list = byOutlet.get(inv.outletId) ?? [];
      list.push(inv);
      byOutlet.set(inv.outletId, list);
    }

    const candidates = [...byOutlet.entries()].filter(([, invs]) =>
      productIds.every((pid) => {
        const inv = invs.find((i) => i.productId === pid);
        return inv && inv.stock - inv.reserved >= (qtyByProduct.get(pid) ?? 0);
      }),
    );

    if (candidates.length === 0) {
      throw new BadRequestException('No single outlet can fulfil all items in this order.');
    }

    // Quote shipping + compute metrics per candidate.
    const destLat = toNum(address.latitude);
    const destLng = toNum(address.longitude);
    const scored = await Promise.all(
      candidates.map(async ([outletId, invs]) => {
        const outlet = invs[0].outlet;
        const quotes = await this.shipping.getQuotes({
          originPostalCode: outlet.postalCode ?? '',
          destinationPostalCode: address.postalCode ?? '',
          weightGram,
          originLatitude: toNum(outlet.latitude) ?? undefined,
          originLongitude: toNum(outlet.longitude) ?? undefined,
          destinationLatitude: destLat ?? undefined,
          destinationLongitude: destLng ?? undefined,
          paxelBoxSize: selectPaxelBox(totalQuantity),
          ...regionFields(outlet, address),
        });
        const cheapest = [...quotes].sort((a, b) => a.shippingCost - b.shippingCost)[0];
        const remainingStock = productIds.reduce((sum, pid) => {
          const inv = invs.find((i) => i.productId === pid)!;
          return sum + (inv.stock - inv.reserved - (qtyByProduct.get(pid) ?? 0));
        }, 0);
        return {
          outletId,
          outlet,
          quotes,
          distance: distanceKm(toNum(outlet.latitude), toNum(outlet.longitude), destLat, destLng),
          shippingCost: cheapest?.shippingCost ?? Number.POSITIVE_INFINITY,
          eta: cheapest ? etaDays(cheapest.estimatedDays) : 99,
          remainingStock,
        };
      }),
    );

    const best = this.pickBest(scored);
    this.logger.log({ event: 'allocation.selected', outletId: best.outletId, score: best.score });
    return {
      outletId: best.outletId,
      outlet: outletProjection(best.outlet),
      quotes: best.quotes,
      score: best.score,
      usedFallback: false,
    };
  }

  private pickBest<T extends { distance: number; shippingCost: number; eta: number; remainingStock: number }>(
    scored: T[],
  ): T & { score: number } {
    const dists = scored.map((s) => s.distance);
    const costs = scored.map((s) => s.shippingCost);
    const etas = scored.map((s) => s.eta);
    const stocks = scored.map((s) => s.remainingStock);
    const range = (arr: number[]) => [Math.min(...arr), Math.max(...arr)] as const;
    const [dMin, dMax] = range(dists);
    const [cMin, cMax] = range(costs);
    const [eMin, eMax] = range(etas);
    const [sMin, sMax] = range(stocks);

    const withScore = scored.map((s) => ({
      ...s,
      score:
        W.distance * normalize(s.distance, dMin, dMax) +
        W.shipping * normalize(s.shippingCost, cMin, cMax) +
        W.eta * normalize(s.eta, eMin, eMax) +
        W.stock * (1 - normalize(s.remainingStock, sMin, sMax)), // more stock → lower score
    }));
    return withScore.sort((a, b) => a.score - b.score)[0];
  }

  private async fallbackToActiveOutlet(
    address: AllocationAddress,
    weightGram: number,
    totalQuantity: number,
  ): Promise<AllocationResult> {
    const outlet = await this.prisma.outlet.findFirst({
      where: { isActive: true },
      include: OUTLET_REGION_NAMES.include,
    });
    if (!outlet) return { outletId: null, outlet: null, quotes: [], score: 0, usedFallback: true };
    const quotes = await this.shipping.getQuotes({
      originPostalCode: outlet.postalCode ?? '',
      destinationPostalCode: address.postalCode ?? '',
      weightGram,
      originLatitude: toNum(outlet.latitude) ?? undefined,
      originLongitude: toNum(outlet.longitude) ?? undefined,
      destinationLatitude: toNum(address.latitude) ?? undefined,
      destinationLongitude: toNum(address.longitude) ?? undefined,
      paxelBoxSize: selectPaxelBox(totalQuantity),
      ...regionFields(outlet, address),
    });
    return {
      outletId: outlet.id,
      outlet: outletProjection(outlet),
      quotes,
      score: 0,
      usedFallback: true,
    };
  }

  private async assertCoverage(address: AllocationAddress): Promise<void> {
    if (!this.coverage || !address.provinceId || !address.cityId) return;
    const match = await this.coverage.resolve({
      provinceId: address.provinceId,
      cityId: address.cityId,
      districtId: address.districtId,
      villageId: address.villageId,
    });
    if (match?.coverageType === 'DISABLED') throw new BadRequestException('Sorry, we do not currently deliver to your location.');
    if (match?.coverageType === 'PICKUP_ONLY') throw new BadRequestException('This area is only available for Pickup.');
  }
}
