import { RequestMethod, ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { LogService } from './infrastructure/logging/log.service';
import { RequestLoggingMiddleware } from './infrastructure/logging/request-logging.middleware';
import { CsrfGuard } from './common/auth/csrf.guard';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    { bufferLogs: true },
  ); const logger = app.get(Logger);
  app.useLogger(logger);

  // /metrics is served outside the API prefix/version (Prometheus scrape convention).
  app.setGlobalPrefix(process.env.API_PREFIX ?? 'api', {
    exclude: [{ path: 'metrics', method: RequestMethod.GET }],
  });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: process.env.API_VERSION ?? '1' });
  const allowedOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  // Explicit allowlist only — never reflect arbitrary origins back with credentials.
  // A request with no Origin header (same-origin, curl, server-to-server) is allowed;
  // a cross-origin request is allowed only if its origin is in CORS_ORIGINS. The env
  // validation requires a non-empty, wildcard-free CORS_ORIGINS in staging/production.
  app.enableCors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
  });
  // Enterprise logging center: assign a requestId, run the request inside an ALS
  // context, and persist a request.finished log. Applied via app.use (robust across
  // Express versions) and early so the requestId covers the whole request.
  const requestLogging = app.get(RequestLoggingMiddleware);
  app.use(requestLogging.use.bind(requestLogging));
  app.use(
    helmet({
      crossOriginResourcePolicy: {
        policy: 'cross-origin',
      },
    }),
  );
  app.use(cookieParser(process.env.COOKIE_SECRET));
  // Phase 13A.6: stateless double-submit CSRF guard. Registered as an ADDITIONAL
  // global guard — runs independently of the APP_GUARD ThrottlerGuard, does not
  // replace it. No DI dependencies (reads env via loadCookieConfig).
  app.useGlobalGuards(new CsrfGuard());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  // AllExceptionsFilter also tees exceptions to the SystemLog center (additive).
  app.useGlobalFilters(new AllExceptionsFilter(logger, app.get(LogService)));
  // Ensure OnModuleDestroy fires on SIGTERM/SIGINT so the outbox relay stops
  // its loop and closes the shared AMQP connection cleanly.
  app.enableShutdownHooks();
  app.useStaticAssets(
    join(process.cwd(), 'uploads'),
    {
      prefix: '/uploads/',
    },
  );

  // Swagger enumerates the full API surface (incl. admin/system routes), so it is
  // OFF in production unless SWAGGER_ENABLED=true explicitly opts back in.
  const swaggerEnabled = process.env.SWAGGER_ENABLED === 'true' || process.env.NODE_ENV !== 'production';
  if (swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Bakso Mas Sular API')
      .setDescription('Storefront, checkout, admin CMS, payment, and shipping APIs.')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swaggerConfig));
  }

  await app.listen(Number(process.env.PORT ?? 3001), '0.0.0.0');
}

void bootstrap();
