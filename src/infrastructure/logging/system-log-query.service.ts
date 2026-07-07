import { Injectable, NotFoundException } from '@nestjs/common';
import { LogLevel, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { pageArgs, paginate } from '../../common/pagination/pagination';

export interface SystemLogQuery {
  page?: number;
  limit?: number;
  search?: string;
  level?: LogLevel;
  module?: string;
  action?: string;
  requestId?: string;
  userId?: string;
  orderId?: string;
  paymentId?: string;
  statusCode?: number;
  dateFrom?: Date;
  dateTo?: Date;
  sort?: 'asc' | 'desc';
}

/** Read-only search + detail for SystemLog. Always paginated (never returns all). */
@Injectable()
export class SystemLogQueryService {
  constructor(private readonly prisma: PrismaService) {}

  buildWhere(query: SystemLogQuery): Prisma.SystemLogWhereInput {
    const term = query.search?.trim();
    const createdAt: Prisma.DateTimeFilter = {};
    if (query.dateFrom) createdAt.gte = query.dateFrom;
    if (query.dateTo) createdAt.lte = query.dateTo;

    return {
      level: query.level,
      module: query.module,
      action: query.action,
      requestId: query.requestId,
      userId: query.userId,
      orderId: query.orderId,
      paymentId: query.paymentId,
      statusCode: query.statusCode,
      ...(query.dateFrom || query.dateTo ? { createdAt } : {}),
      ...(term
        ? {
            OR: [
              { message: { contains: term } },
              { requestId: term },
              { orderId: term },
              { paymentId: term },
              { userId: term },
              { adminId: term },
            ],
          }
        : {}),
    };
  }

  async list(query: SystemLogQuery) {
    const { skip, take, page, limit } = pageArgs(query);
    const where = this.buildWhere(query);
    // Newest first by default; index-backed (createdAt / composite indexes).
    const orderBy: Prisma.SystemLogOrderByWithRelationInput = { createdAt: query.sort === 'asc' ? 'asc' : 'desc' };
    const [items, total] = await Promise.all([
      this.prisma.systemLog.findMany({ where, orderBy, skip, take }),
      this.prisma.systemLog.count({ where }),
    ]);
    return paginate(items, total, page, limit);
  }

  async get(id: string) {
    const log = await this.prisma.systemLog.findUnique({ where: { id } });
    if (!log) throw new NotFoundException('Log not found');
    return log;
  }
}
