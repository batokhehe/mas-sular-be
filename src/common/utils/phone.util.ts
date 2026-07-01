/** Invalid/empty/unsupported recipient phone — non-retryable (skip + warn). */
export class InvalidPhoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPhoneError';
  }
}

/**
 * Normalize an Indonesian MSISDN to Qontak/WhatsApp form (`628xxxxxxxx`):
 *   08xxxxxxxx → 628xxxxxxxx · +628xxx → 628xxx · 628xxx → 628xxx
 * Throws InvalidPhoneError on empty / non-numeric / unsupported input.
 */
export function normalizePhoneNumber(raw: string | null | undefined): string {
  if (!raw || !raw.trim()) {
    throw new InvalidPhoneError('phone number is empty');
  }
  // Keep digits only (drop spaces, dashes, parentheses, leading +).
  const digits = raw.replace(/[^0-9]/g, '');
  if (!digits) {
    throw new InvalidPhoneError(`phone number has no digits: "${raw}"`);
  }

  let msisdn: string;
  if (digits.startsWith('62')) {
    msisdn = digits;
  } else if (digits.startsWith('0')) {
    msisdn = `62${digits.slice(1)}`;
  } else if (digits.startsWith('8')) {
    msisdn = `62${digits}`;
  } else {
    throw new InvalidPhoneError(`unsupported phone format: "${raw}"`);
  }

  // 62 + 9..13 subscriber digits (Indonesian mobile range).
  if (msisdn.length < 11 || msisdn.length > 15) {
    throw new InvalidPhoneError(`phone number length out of range: "${raw}"`);
  }
  return msisdn;
}

/** Mask a normalized phone for logs: 628****1234. */
export function maskPhone(phone: string): string {
  if (phone.length <= 7) return '***';
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}
