import { PermanentError } from '../../../shipping/domain/shipping-errors';

/**
 * The business timezone every Paxel pickup slot is expressed in.
 *
 * Paxel is an Indonesian courier and its `pickup_datetime` carries NO offset —
 * it is a naive wall-clock string that Paxel reads as local Indonesian time.
 * Verified against staging: sending "2026-08-24 10:00:00" scheduled a 10:00-12:00
 * pickup window, and sending "2026-08-24 03:00:00" scheduled 08:00-10:00. Paxel
 * accepts both silently, so the string we send IS the appointment.
 */
export const PAXEL_BUSINESS_TIMEZONE = 'Asia/Jakarta';

/**
 * Renders the instant in PAXEL_BUSINESS_TIMEZONE, never in the process timezone.
 *
 * `hourCycle: 'h23'` rather than `hour12: false`: the latter renders midnight as
 * hour "24" on some ICU versions, which would send an invalid "24:00:00".
 */
const PAXEL_DATETIME_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: PAXEL_BUSINESS_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/**
 * Format an instant as Paxel's `YYYY-MM-DD HH:mm:ss`, in Asia/Jakarta.
 *
 * Deliberately NOT `Date#getHours()` and friends: those read the Node process
 * timezone, which is Asia/Jakarta on a developer machine but UTC inside the
 * container (no TZ is set in any Dockerfile). That discrepancy silently shifted
 * every booking by 7 hours — the admin selected 10:00, the courier was
 * scheduled for 08:00-10:00, and Paxel returned 200 either way so nothing
 * surfaced the error. The timezone is stated here explicitly so the output no
 * longer depends on where the process happens to run.
 */
export function formatPaxelDatetime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    throw new PermanentError('Pickup date and time are invalid', 'paxel');
  }

  const parts: Record<string, string> = {};
  for (const { type, value } of PAXEL_DATETIME_PARTS.formatToParts(at)) {
    parts[type] = value;
  }

  return (
    `${parts.year}-${parts.month}-${parts.day} ` + `${parts.hour}:${parts.minute}:${parts.second}`
  );
}
