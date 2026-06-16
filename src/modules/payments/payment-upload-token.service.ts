import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../../database/prisma.service';

/** Default token lifetime: 72 hours. */
export const UPLOAD_TOKEN_TTL_MS = 72 * 60 * 60 * 1000;

export interface IssuedUploadToken {
  rawToken: string; // the URL secret — emailed, never persisted in plaintext
  uploadUrl: string;
  expiresAt: Date;
}

export interface ResolvedUploadToken {
  id: string;
  paymentId: string;
  expiresAt: Date;
  usedAt: Date | null;
}

/**
 * Lifecycle for the single-use payment-upload capability token. Only the SHA-256
 * hash of the URL secret is stored, so a DB leak yields no usable links. Tokens
 * are single-use (CAS on usedAt) and auto-expire (expiresAt).
 */
@Injectable()
export class PaymentUploadTokenService {
  // Overridable seam for deterministic tests.
  private nowMs: () => number = () => Date.now();

  constructor(private readonly prisma: PrismaService) {}

  private get baseUrl(): string {
    return (process.env.PAYMENT_UPLOAD_BASE_URL ?? '').replace(/\/+$/, '');
  }

  hash(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
  }

  buildUrl(rawToken: string): string {
    return `${this.baseUrl}/payments/upload/${rawToken}`;
  }

  /** Issue a token row (storing only the hash) inside the caller's transaction. */
  async issue(tx: Prisma.TransactionClient, paymentId: string): Promise<IssuedUploadToken> {
    const rawToken = randomBytes(32).toString('hex'); // 256-bit secret
    const expiresAt = new Date(this.nowMs() + UPLOAD_TOKEN_TTL_MS);
    await tx.paymentUploadToken.create({ data: { token: this.hash(rawToken), paymentId, expiresAt } });
    return { rawToken, uploadUrl: this.buildUrl(rawToken), expiresAt };
  }

  /** Resolve a token by its raw secret if it is unused and unexpired; null otherwise. */
  async resolveActive(rawToken: string): Promise<ResolvedUploadToken | null> {
    const row = await this.prisma.paymentUploadToken.findUnique({ where: { token: this.hash(rawToken) } });
    if (!row) return null;
    if (row.usedAt) return null;
    if (row.expiresAt.getTime() <= this.nowMs()) return null;
    return row;
  }

  /**
   * Single-use CAS consume inside the caller's transaction. Returns whether this
   * call marked the token used (false → missing/used/expired). The paymentId is
   * returned for the caller to act on when consumed.
   */
  async consume(tx: Prisma.TransactionClient, rawToken: string): Promise<{ consumed: boolean; paymentId: string | null }> {
    const row = await tx.paymentUploadToken.findUnique({ where: { token: this.hash(rawToken) } });
    if (!row) return { consumed: false, paymentId: null };
    const flip = await tx.paymentUploadToken.updateMany({
      where: { id: row.id, usedAt: null, expiresAt: { gt: new Date(this.nowMs()) } },
      data: { usedAt: new Date(this.nowMs()) },
    });
    return { consumed: flip.count === 1, paymentId: row.paymentId };
  }
}
