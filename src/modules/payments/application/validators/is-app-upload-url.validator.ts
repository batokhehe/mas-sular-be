import { registerDecorator, ValidationOptions } from 'class-validator';

// An application-owned upload path: /uploads/<normalized-filename>.<image-ext>.
// normalizeUploadFilename() produces "<ts>-<hex>.<ext>", so only safe chars + an
// allowed image extension are accepted (no path traversal, no javascript: URLs).
const APP_UPLOAD_PATH = /^\/uploads\/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$/i;

/**
 * True only when `value` references an application-owned upload — either a
 * root-relative `/uploads/<file>` path or an absolute URL on the configured
 * APP_URL host under `/uploads/`. Arbitrary/external/`javascript:` URLs are rejected.
 */
export function isAppUploadUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;

  let pathname: string;
  let host: string | null = null;

  if (value.startsWith('/uploads/')) {
    pathname = value.split(/[?#]/)[0];
  } else {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    pathname = url.pathname;
    host = url.host;
  }

  if (!APP_UPLOAD_PATH.test(pathname)) return false;

  // When an absolute URL is given and APP_URL is configured, the host must match.
  const appUrl = process.env.APP_URL;
  if (host && appUrl) {
    try {
      if (host !== new URL(appUrl).host) return false;
    } catch {
      // APP_URL misconfigured → fall back to path-shape validation only.
    }
  }
  return true;
}

export function IsAppUploadUrl(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isAppUploadUrl',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) => isAppUploadUrl(value),
        defaultMessage: () => 'receiptUrl must reference an application-owned upload (/uploads/<file>)',
      },
    });
  };
}
