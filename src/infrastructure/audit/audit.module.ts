import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuditTrailService } from './audit-trail.service';
import { AuditTrailInterceptor } from './audit.interceptor';

/**
 * Enterprise Audit Trail (additive). The interceptor is registered globally so
 * every admin mutation is recorded automatically — non-admin/non-mutating routes
 * pass through untouched (mapAuditRoute returns null).
 */
@Global()
@Module({
  providers: [
    AuditTrailService,
    { provide: APP_INTERCEPTOR, useClass: AuditTrailInterceptor },
  ],
  exports: [AuditTrailService],
})
export class AuditTrailModule {}
