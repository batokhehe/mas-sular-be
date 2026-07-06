import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CoverageType, DeliveryCoverage, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import {
  CheckCoverageQueryDto,
  CreateDeliveryCoverageDto,
  ListCoverageQueryDto,
  UpdateDeliveryCoverageDto,
} from './application/dto/delivery-coverage.dto';

export interface CoverageCheckResult {
  /** Whether a coverage rule matched this location. Unconfigured areas keep the
   *  legacy behavior (delivery allowed, fee resolved elsewhere). */
  configured: boolean;
  coverageId: string | null;
  coverageType: CoverageType;
  deliveryFee: number;
  minimumOrder: number;
  estimatedMinutes: number | null;
  deliverable: boolean;
  pickupOnly: boolean;
}

interface RegionKey {
  provinceId?: string | null;
  cityId?: string | null;
  districtId?: string | null;
  villageId?: string | null;
}

const REGION_INCLUDE = {
  province: { select: { id: true, name: true } },
  city: { select: { id: true, name: true, type: true } },
  district: { select: { id: true, name: true } },
  village: { select: { id: true, name: true } },
} as const;

const CACHE_TTL_MS = 60_000;

@Injectable()
export class DeliveryCoverageService {
  constructor(private readonly prisma: PrismaService) {}

  // Tiny in-process cache keyed by the 4 region ids. Keeps the coverage lookup
  // well under 20ms and is cleared on every admin write for immediate consistency.
  private cache = new Map<string, { value: DeliveryCoverage | null; expires: number }>();

  private cacheKey(k: RegionKey): string {
    return `${k.provinceId ?? ''}|${k.cityId ?? ''}|${k.districtId ?? ''}|${k.villageId ?? ''}`;
  }

  private clearCache(): void {
    this.cache.clear();
  }

  /**
   * Resolve the most specific active coverage rule for a location, walking
   * Village → District → City. Returns null when no rule matches (unconfigured).
   */
  async resolve(key: RegionKey): Promise<DeliveryCoverage | null> {
    if (!key.provinceId || !key.cityId) return null;

    const cacheId = this.cacheKey(key);
    const hit = this.cache.get(cacheId);
    if (hit && hit.expires > Date.now()) return hit.value;

    const base = { isActive: true, provinceId: key.provinceId, cityId: key.cityId };

    let match: DeliveryCoverage | null = null;
    if (key.villageId) {
      match = await this.prisma.deliveryCoverage.findFirst({ where: { ...base, villageId: key.villageId } });
    }
    if (!match && key.districtId) {
      match = await this.prisma.deliveryCoverage.findFirst({
        where: { ...base, districtId: key.districtId, villageId: null },
      });
    }
    if (!match) {
      match = await this.prisma.deliveryCoverage.findFirst({
        where: { ...base, districtId: null, villageId: null },
      });
    }

    this.cache.set(cacheId, { value: match, expires: Date.now() + CACHE_TTL_MS });
    return match;
  }

  /** Public coverage check for checkout. */
  async check(query: CheckCoverageQueryDto): Promise<CoverageCheckResult> {
    const match = await this.resolve(query);
    if (!match) {
      // Unconfigured location → delivery allowed (legacy), no coverage snapshot.
      return {
        configured: false,
        coverageId: null,
        coverageType: CoverageType.DELIVERY,
        deliveryFee: 0,
        minimumOrder: 0,
        estimatedMinutes: null,
        deliverable: true,
        pickupOnly: false,
      };
    }
    return {
      configured: true,
      coverageId: match.id,
      coverageType: match.coverageType,
      deliveryFee: match.deliveryFee,
      minimumOrder: match.minimumOrder,
      estimatedMinutes: match.estimatedMinutes,
      deliverable: match.coverageType === CoverageType.DELIVERY,
      pickupOnly: match.coverageType === CoverageType.PICKUP_ONLY,
    };
  }

  // ---------------- Admin CRUD ----------------

  list(query: ListCoverageQueryDto) {
    const term = query.search?.trim();
    const nameFilter: Prisma.StringFilter | undefined = term ? { contains: term } : undefined;
    return this.prisma.deliveryCoverage.findMany({
      where: {
        coverageType: query.coverageType,
        isActive: query.isActive,
        provinceId: query.provinceId,
        cityId: query.cityId,
        ...(nameFilter
          ? {
              OR: [
                { province: { name: nameFilter } },
                { city: { name: nameFilter } },
                { district: { name: nameFilter } },
                { village: { name: nameFilter } },
              ],
            }
          : {}),
      },
      include: REGION_INCLUDE,
      orderBy: [{ createdAt: 'desc' }],
    });
  }

  async getById(id: string) {
    const coverage = await this.prisma.deliveryCoverage.findUnique({ where: { id }, include: REGION_INCLUDE });
    if (!coverage) throw new NotFoundException('Delivery coverage not found');
    return coverage;
  }

  private validate(dto: CreateDeliveryCoverageDto | UpdateDeliveryCoverageDto): void {
    if (dto.deliveryFee !== undefined && dto.deliveryFee < 0) throw new BadRequestException('Delivery fee must be >= 0');
    if (dto.minimumOrder !== undefined && dto.minimumOrder < 0) throw new BadRequestException('Minimum order must be >= 0');
    if (dto.estimatedMinutes !== undefined && dto.estimatedMinutes <= 0)
      throw new BadRequestException('Estimated minutes must be > 0');
  }

  async create(dto: CreateDeliveryCoverageDto) {
    this.validate(dto);
    const created = await this.prisma.deliveryCoverage.create({
      data: {
        provinceId: dto.provinceId,
        cityId: dto.cityId,
        districtId: dto.districtId ?? null,
        villageId: dto.villageId ?? null,
        coverageType: dto.coverageType,
        deliveryFee: dto.deliveryFee ?? 0,
        minimumOrder: dto.minimumOrder ?? 0,
        estimatedMinutes: dto.estimatedMinutes ?? 60,
        isActive: dto.isActive ?? true,
      },
      include: REGION_INCLUDE,
    });
    this.clearCache();
    return created;
  }

  async update(id: string, dto: UpdateDeliveryCoverageDto) {
    await this.getById(id);
    this.validate(dto);
    const updated = await this.prisma.deliveryCoverage.update({
      where: { id },
      data: {
        provinceId: dto.provinceId,
        cityId: dto.cityId,
        districtId: dto.districtId === undefined ? undefined : (dto.districtId ?? null),
        villageId: dto.villageId === undefined ? undefined : (dto.villageId ?? null),
        coverageType: dto.coverageType,
        deliveryFee: dto.deliveryFee,
        minimumOrder: dto.minimumOrder,
        estimatedMinutes: dto.estimatedMinutes,
        isActive: dto.isActive,
      },
      include: REGION_INCLUDE,
    });
    this.clearCache();
    return updated;
  }

  async setActive(id: string, isActive: boolean) {
    await this.getById(id);
    const updated = await this.prisma.deliveryCoverage.update({
      where: { id },
      data: { isActive },
      include: REGION_INCLUDE,
    });
    this.clearCache();
    return updated;
  }

  async remove(id: string) {
    await this.getById(id);
    await this.prisma.deliveryCoverage.delete({ where: { id } });
    this.clearCache();
    return { success: true };
  }
}
