import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import {
  ListCitiesQueryDto,
  ListDistrictsQueryDto,
  ListProvincesQueryDto,
  ListVillagesQueryDto,
} from './application/dto/region-query.dto';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;

/**
 * Read-only lookups over the Indonesian administrative master tables.
 * Loading is strictly progressive: each level is fetched on demand, filtered by
 * its parent id — we never preload the full village table.
 */
@Injectable()
export class RegionsService {
  constructor(private readonly prisma: PrismaService) {}

  private take(limit?: number): number {
    if (!limit || limit < 1) return DEFAULT_LIMIT;
    return Math.min(limit, MAX_LIMIT);
  }

  /** Active-only unless the caller explicitly passes isActive=false. */
  private activeFilter(isActive?: boolean): boolean | undefined {
    return isActive === false ? false : true;
  }

  private searchFilter(search?: string): Prisma.StringFilter | undefined {
    const term = search?.trim();
    return term ? { contains: term } : undefined;
  }

  listProvinces(query: ListProvincesQueryDto) {
    const name = this.searchFilter(query.search);
    return this.prisma.province.findMany({
      where: {
        isActive: this.activeFilter(query.isActive),
        ...(name ? { OR: [{ name }, { code: name }] } : {}),
      },
      orderBy: { name: 'asc' },
      take: this.take(query.limit),
      select: { id: true, code: true, name: true, isActive: true },
    });
  }

  listCities(query: ListCitiesQueryDto) {
    const name = this.searchFilter(query.search);
    return this.prisma.city.findMany({
      where: {
        isActive: this.activeFilter(query.isActive),
        ...(query.provinceId ? { provinceId: query.provinceId } : {}),
        ...(name ? { OR: [{ name }, { code: name }] } : {}),
      },
      orderBy: { name: 'asc' },
      take: this.take(query.limit),
      select: { id: true, code: true, name: true, type: true, provinceId: true, isActive: true },
    });
  }

  listDistricts(query: ListDistrictsQueryDto) {
    const name = this.searchFilter(query.search);
    return this.prisma.district.findMany({
      where: {
        isActive: this.activeFilter(query.isActive),
        ...(query.cityId ? { cityId: query.cityId } : {}),
        ...(name ? { OR: [{ name }, { code: name }] } : {}),
      },
      orderBy: { name: 'asc' },
      take: this.take(query.limit),
      select: { id: true, code: true, name: true, cityId: true, isActive: true },
    });
  }

  listVillages(query: ListVillagesQueryDto) {
    const name = this.searchFilter(query.search);
    return this.prisma.village.findMany({
      where: {
        isActive: this.activeFilter(query.isActive),
        ...(query.districtId ? { districtId: query.districtId } : {}),
        ...(name ? { OR: [{ name }, { code: name }] } : {}),
      },
      orderBy: { name: 'asc' },
      take: this.take(query.limit),
      select: {
        id: true,
        code: true,
        name: true,
        postalCode: true,
        districtId: true,
        isActive: true,
      },
    });
  }
}
