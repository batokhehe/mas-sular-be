import { Inject, Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { IdempotencyKey, IdempotencyStatus, Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { hostname } from 'os';
import { PrismaService } from '../../database/prisma.service';
import { IDEMPOTENCY_CONFIG, IdempotencyConfig, ReplayMode } from './idempotency.config';

export interface IdempotencyContext {
  userId: string;
  key: string;
  method: string;
  endpoint: string;
  /** Canonical request projection that is hashed into the fingerprint. */
  fingerprintInput: unknown;
}

export type BeginResult =
  | { kind: 'proceed'; record: IdempotencyKey }
  | { kind: 'replay'; statusCode: number; body: Prisma.JsonValue; resourceType: string | null; resourceId: string | null }
  | { kind: 'processing' };

/** Resolution of a key when the caller no longer owns it (already replay/processing). */
export type ResolveResult = Exclude<BeginResult, { kind: 'proceed' }>;

/**
 * Thrown by finalize()/markFailed() guards when the caller's fenceToken no longer
 * matches the row: the reservation was reclaimed by a newer owner. Raising this
 * inside the order transaction rolls the whole unit back.
 */
export class SupersededError extends Error {
  constructor(
    public readonly recordId: string,
    public readonly fenceToken: number,
  ) {
    super(`Idempotency reservation ${recordId} was superseded (fenceToken ${fenceToken})`);
    this.name = 'SupersededError';
  }
}

export interface FinalizeData {
  statusCode: number;
  body: Prisma.InputJsonValue;
  resourceType?: string;
  resourceId?: string;
}

/**
 * Generic, reusable idempotency over the IdempotencyKey table. The caller:
 *   1. begin(ctx)  -> reserve a key (single winner) or get a replay / 409 signal
 *   2. finalize(tx,...) inside its own write transaction (atomic with the result)
 *   3. markFailed(...) on error so the key becomes retryable
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);
  private nowMs: () => number = () => Date.now();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(IDEMPOTENCY_CONFIG) private readonly config: IdempotencyConfig,
  ) {}

  isCheckoutEnabled(): boolean {
    return this.config.checkoutEnabled;
  }

  isCheckoutRequired(): boolean {
    return this.config.checkoutRequired;
  }

  replayMode(): ReplayMode {
    return this.config.replayMode;
  }

  retryAfterSeconds(): number {
    return this.config.retryAfterSeconds;
  }

  computeFingerprint(input: unknown): string {
    return createHash('sha256').update(stableStringify(input)).digest('hex');
  }

  async begin(ctx: IdempotencyContext): Promise<BeginResult> {
    const fingerprint = this.computeFingerprint(ctx.fingerprintInput);
    const where = { userId_idempotencyKey: { userId: ctx.userId, idempotencyKey: ctx.key } };

    const existing = await this.prisma.idempotencyKey.findUnique({ where });
    if (existing) {
      const handled = await this.handleExisting(existing, fingerprint, ctx);
      if (handled) return handled;
    } else {
      try {
        const record = await this.prisma.idempotencyKey.create({
          data: {
            userId: ctx.userId,
            idempotencyKey: ctx.key,
            requestMethod: ctx.method,
            endpoint: ctx.endpoint,
            requestFingerprint: fingerprint,
            status: IdempotencyStatus.PROCESSING,
            // fenceToken defaults to 1 (first owner).
            ownerId: this.newOwnerId(),
            ownershipAcquiredAt: new Date(this.nowMs()),
            createdAt: new Date(this.nowMs()),
            expiresAt: new Date(this.nowMs() + this.config.retentionMs),
          },
        });
        return { kind: 'proceed', record };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Concurrent reserve won the race; fall through to resolve against its row.
      }
    }

    // Single re-read to resolve a race (post-conflict, or a lost reclaim/re-reserve).
    const row = await this.prisma.idempotencyKey.findUnique({ where });
    if (!row) return { kind: 'processing' };
    const handled = await this.handleExisting(row, fingerprint, ctx);
    return handled ?? { kind: 'processing' };
  }

  /**
   * Finalize the reserved key inside the caller's transaction so the COMPLETED
   * record commits atomically with the created resource. Fenced: only succeeds
   * if fenceToken still matches (the caller still owns the reservation). On a
   * mismatch it throws SupersededError, rolling back the caller's transaction.
   */
  async finalize(
    tx: Prisma.TransactionClient,
    recordId: string,
    fenceToken: number,
    data: FinalizeData,
  ): Promise<void> {
    const result = await tx.idempotencyKey.updateMany({
      where: { id: recordId, fenceToken, status: IdempotencyStatus.PROCESSING },
      data: {
        status: IdempotencyStatus.COMPLETED,
        responseStatusCode: data.statusCode,
        responseBody: data.body,
        resourceType: data.resourceType ?? null,
        resourceId: data.resourceId ?? null,
      },
    });
    if (result.count !== 1) {
      throw new SupersededError(recordId, fenceToken);
    }
  }

  /**
   * Fenced FAILED transition. Only flips the row if the caller still owns it
   * (fenceToken matches and it is still PROCESSING); a superseded caller is a
   * no-op so it cannot clobber the new owner's in-flight reservation.
   */
  async markFailed(recordId: string, fenceToken: number, error: unknown): Promise<void> {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    try {
      await this.prisma.idempotencyKey.updateMany({
        where: { id: recordId, fenceToken, status: IdempotencyStatus.PROCESSING },
        data: { status: IdempotencyStatus.FAILED, lastError: message },
      });
    } catch (err) {
      // Best-effort; never mask the original checkout error.
      this.logger.warn(`Failed to mark idempotency ${recordId} FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Resolve a key after the caller's finalize was superseded: the order rolled
   * back, so return the winner's response (replay) or signal still-in-progress.
   */
  async resolveAfterSupersession(userId: string, key: string): Promise<ResolveResult> {
    const row = await this.prisma.idempotencyKey.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey: key } },
    });
    if (row && row.status === IdempotencyStatus.COMPLETED) {
      return {
        kind: 'replay',
        statusCode: row.responseStatusCode ?? 200,
        body: (row.responseBody ?? {}) as Prisma.JsonValue,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
      };
    }
    return { kind: 'processing' };
  }

  private async handleExisting(
    record: IdempotencyKey,
    fingerprint: string,
    ctx: IdempotencyContext,
  ): Promise<BeginResult | null> {
    if (record.requestFingerprint !== fingerprint) {
      throw new UnprocessableEntityException('Idempotency-Key was already used with a different request');
    }
    if (record.status === IdempotencyStatus.COMPLETED) {
      return {
        kind: 'replay',
        statusCode: record.responseStatusCode ?? 200,
        body: (record.responseBody ?? {}) as Prisma.JsonValue,
        resourceType: record.resourceType,
        resourceId: record.resourceId,
      };
    }
    if (record.status === IdempotencyStatus.FAILED) {
      const claimed = await this.claim(record.id, record.fenceToken, fingerprint, ctx, 'FAILED');
      return claimed ? { kind: 'proceed', record: claimed } : null;
    }
    // PROCESSING
    if (this.isReclaimable(record)) {
      const claimed = await this.claim(record.id, record.fenceToken, fingerprint, ctx, 'STUCK');
      return claimed ? { kind: 'proceed', record: claimed } : null;
    }
    return { kind: 'processing' };
  }

  private isReclaimable(record: IdempotencyKey): boolean {
    // Reclaim is driven by ownership age (createdAt stays immutable). Fall back to
    // createdAt only for legacy rows that predate ownershipAcquiredAt.
    const acquiredAt = record.ownershipAcquiredAt ?? record.createdAt;
    return acquiredAt.getTime() < this.nowMs() - this.config.reclaimMs;
  }

  /**
   * Conditional CAS claim of a FAILED or stuck-PROCESSING row: bumps fenceToken,
   * transfers ownership, and leaves createdAt untouched. Single winner via the
   * fenceToken compare-and-swap (updateMany count === 1).
   */
  private async claim(
    id: string,
    expectedToken: number,
    fingerprint: string,
    ctx: IdempotencyContext,
    mode: 'FAILED' | 'STUCK',
  ): Promise<IdempotencyKey | null> {
    const where: Prisma.IdempotencyKeyWhereInput =
      mode === 'FAILED'
        ? { id, fenceToken: expectedToken, status: IdempotencyStatus.FAILED }
        : {
            id,
            fenceToken: expectedToken,
            status: IdempotencyStatus.PROCESSING,
            ownershipAcquiredAt: { lt: new Date(this.nowMs() - this.config.reclaimMs) },
          };

    const result = await this.prisma.idempotencyKey.updateMany({
      where,
      data: {
        status: IdempotencyStatus.PROCESSING,
        fenceToken: { increment: 1 },
        ownerId: this.newOwnerId(),
        ownershipAcquiredAt: new Date(this.nowMs()),
        requestFingerprint: fingerprint,
        requestMethod: ctx.method,
        endpoint: ctx.endpoint,
        expiresAt: new Date(this.nowMs() + this.config.retentionMs),
        lastError: null,
        responseStatusCode: null,
        resourceType: null,
        resourceId: null,
      },
    });
    if (result.count !== 1) return null;
    return this.prisma.idempotencyKey.findUnique({ where: { id } });
  }

  private newOwnerId(): string {
    return `${hostname()}:${process.pid}#${randomUUID()}`;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/** Deterministic JSON with recursively sorted object keys (arrays keep order). */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeys((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}
