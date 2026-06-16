import { Controller, Get, Inject } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { ApiTags } from '@nestjs/swagger';
import { Cache } from 'cache-manager';
import amqp from 'amqplib';
import { PrismaService } from './database/prisma.service';

@ApiTags('health')
@Controller({ path: 'health', version: '1' })
export class HealthController {
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

  @Get('redis')
  async redisTest() {
    try {
      console.log('SET');

      await this.cacheManager.set('test', 'hello');

      console.log('GET');

      const value = await this.cacheManager.get('test');

      console.log('VALUE', value);

      return { value };
    } catch (e) {
      console.error('CACHE ERROR', e);

      return {
        error: String(e),
      };
    }
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
      console.error(error);

      checks.redis = 'failed';
    }

    // RabbitMQ is required whenever the relay or consumers are enabled. When it is
    // required but unreachable (or unset), readiness fails — we never report ready
    // while the async infrastructure is broken. When not required, it is skipped.
    const rabbitRequired =
      process.env.OUTBOX_RELAY_ENABLED === 'true' || process.env.CONSUMERS_ENABLED === 'true';
    if (process.env.RABBITMQ_URL) {
      try {
        const connection = await amqp.connect(process.env.RABBITMQ_URL);
        await connection.close();
        checks.rabbitmq = 'ok';
      } catch (error) {
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
