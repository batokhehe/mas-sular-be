import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { LogLevel } from '@prisma/client';
import { Logger } from 'nestjs-pino';
import { redactSensitivePath } from '../logging/redact';
import { LogService } from '../../infrastructure/logging/log.service';
import { getRequestId } from '../../infrastructure/logging/request-context';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  // logService is optional so the filter still works if it is ever constructed
  // without it; when present, every exception is also persisted to SystemLog.
  constructor(
    private readonly logger: Logger,
    private readonly logService?: LogService,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest<{ url: string; method: string }>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const rawMessage = exception instanceof HttpException ? exception.getResponse() : 'Internal server error';
    const message = this.parseMessage(rawMessage);

    // Redact capability tokens (e.g. the payment upload token) from the LOGGED url.
    // The response `path` is returned only to the caller who already holds the token,
    // so it is left unchanged (no API behavior change).
    this.logger.error({ err: exception, method: request.method, url: redactSensitivePath(request.url) }, 'request failed');

    // ADDITIVE: persist the exception to the SystemLog center (with stack + status).
    this.logService?.write({
      level: status >= 500 ? LogLevel.ERROR : LogLevel.WARN,
      module: 'exception',
      action: exception instanceof Error ? exception.constructor.name : 'UnknownException',
      message,
      requestId: getRequestId() ?? null,
      method: request.method,
      path: redactSensitivePath(request.url),
      statusCode: status,
      metadata: {
        name: exception instanceof Error ? exception.name : undefined,
        stack: exception instanceof Error ? exception.stack : undefined,
      },
    });

    response.status(status).json({
      statusCode: status,
      message,
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }

  private parseMessage(raw: unknown): string {
    if (typeof raw === 'string') {
      return raw;
    }

    if (Array.isArray(raw)) {
      return raw.map((item) => this.parseMessage(item)).join(', ');
    }

    if (raw && typeof raw === 'object') {
      const messageField = (raw as Record<string, unknown>).message;
      if (messageField !== undefined) {
        return this.parseMessage(messageField);
      }

      const errorField = (raw as Record<string, unknown>).error;
      if (typeof errorField === 'string') {
        return `${errorField}`;
      }

      return JSON.stringify(raw);
    }

    return String(raw);
  }
}
