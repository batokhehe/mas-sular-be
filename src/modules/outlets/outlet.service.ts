import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { CreateOutletDto, UpdateOutletDto } from './application/dto/outlet.dto';

const REGION_INCLUDE = {
  province: { select: { id: true, name: true } },
  city: { select: { id: true, name: true, type: true } },
  district: { select: { id: true, name: true } },
  village: { select: { id: true, name: true, postalCode: true } },
} as const;

/** The active outlet as the shipping origin (real data for the providers). */
export interface ActiveOutletOrigin {
  id: string;
  name: string;
  postalCode: string | null;
  latitude: number | null;
  longitude: number | null;
}

@Injectable()
export class OutletService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.outlet.findMany({
      include: REGION_INCLUDE,
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async getById(id: string) {
    const outlet = await this.prisma.outlet.findUnique({ where: { id }, include: REGION_INCLUDE });
    if (!outlet) throw new NotFoundException('Outlet not found');
    return outlet;
  }

  /** The single active outlet, or null when none is configured. */
  async getActive(): Promise<ActiveOutletOrigin | null> {
    const outlet = await this.prisma.outlet.findFirst({ where: { isActive: true } });
    if (!outlet) return null;
    return {
      id: outlet.id,
      name: outlet.name,
      postalCode: outlet.postalCode,
      latitude: outlet.latitude === null ? null : Number(outlet.latitude),
      longitude: outlet.longitude === null ? null : Number(outlet.longitude),
    };
  }

  async create(dto: CreateOutletDto) {
    return this.prisma.outlet.create({ data: { ...dto, isActive: false }, include: REGION_INCLUDE });
  }

  async update(id: string, dto: UpdateOutletDto) {
    await this.getById(id);
    return this.prisma.outlet.update({ where: { id }, data: { ...dto }, include: REGION_INCLUDE });
  }

  /** Exactly-one-active invariant: deactivate all others, then activate this one. */
  async activate(id: string) {
    await this.getById(id);
    return this.prisma.$transaction(async (tx) => {
      await tx.outlet.updateMany({ where: { isActive: true, NOT: { id } }, data: { isActive: false } });
      return tx.outlet.update({ where: { id }, data: { isActive: true }, include: REGION_INCLUDE });
    });
  }

  async remove(id: string) {
    const outlet = await this.getById(id);
    if (outlet.isActive) throw new ConflictException('Cannot delete the active outlet');
    await this.prisma.outlet.delete({ where: { id } });
    return { success: true };
  }
}
