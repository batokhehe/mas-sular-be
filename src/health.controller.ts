import { Controller, Get, Inject, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { ApiTags } from '@nestjs/swagger';
import { Cache } from 'cache-manager';
// NAMESPACE import, matching every other amqplib call site in this codebase.
// A default import emits `amqplib_1.default.connect(...)` under `module: commonjs`
// without `esModuleInterop`, and amqplib is CommonJS with no `default` export — so
// it threw "Cannot read properties of undefined (reading 'connect')" before any
// socket was opened. `allowSyntheticDefaultImports` silenced the type error but
// changes no emit, which is why it compiled cleanly and failed only at runtime.
import * as amqp from 'amqplib';
import { PrismaService } from './database/prisma.service';
import { amqpErrorInfo, describeAmqpTarget } from './common/diagnostics/amqp-redact';

@ApiTags('health')
@Controller({ path: 'health', version: '1' })
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) { }

  @Get()
  health() {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  async ready() {
    const checks: Record<string, string> = {};

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.mysql = 'ok';
    } catch (error) {
      checks.mysql = 'failed';
    }

    try {
      await this.cacheManager.set('health-check', 'ok');
      const value = await this.cacheManager.get<string>('health-check');
      checks.redis = value === 'ok' ? 'ok' : 'failed';
    } catch (error) {
      this.logger.error(`Redis readiness check failed: ${error instanceof Error ? error.message : String(error)}`);
      checks.redis = 'failed';
    }

    // RabbitMQ is required whenever the relay or consumers are enabled. When it is
    // required but unreachable (or unset), readiness fails — we never report ready
    // while the async infrastructure is broken. When not required, it is skipped.
    const rabbitRequired =
      process.env.OUTBOX_RELAY_ENABLED === 'true' || process.env.CONSUMERS_ENABLED === 'true';
    if (process.env.RABBITMQ_URL) {
      // TEMP DIAGNOSTICS (remove once staging RabbitMQ is confirmed): log the
      // credential-free target and the exact error. Status logic is unchanged.
      const target = describeAmqpTarget(process.env.RABBITMQ_URL);
      try {
        this.logger.log(`RabbitMQ readiness probe -> ${target}`);
        const connection = await amqp.connect(process.env.RABBITMQ_URL);
        await connection.close();
        this.logger.log(`RabbitMQ readiness OK -> ${target}`);
        checks.rabbitmq = 'ok';
      } catch (error) {
        this.logger.error(`RabbitMQ readiness FAILED -> ${target} ${amqpErrorInfo(error)}`);
        checks.rabbitmq = 'failed';
      }
    } else {
      checks.rabbitmq = rabbitRequired ? 'failed' : 'skipped';
    }

    const status = Object.values(checks).every((value) => value === 'ok' || value === 'skipped') ? 'ready' : 'not_ready';
    return { status, checks };
  }

  @Get('live')
  live() {
    return { status: 'live' };
  }
}
