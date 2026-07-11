// Collection schedule — shared by the Worker (settings UI + API) and the Node
// collector. The GitHub Actions cron fires nightly; the collector reads this
// schedule and only actually runs when "today" is due. Manual runs ignore it.

export type Frequency = 'daily' | 'weekly' | 'biweekly' | 'monthly';

export interface CollectionSchedule {
  frequency: Frequency;
  dayOfWeek?: number; // 0=Sunday … 6=Saturday (weekly / biweekly)
  dayOfMonth?: number; // 1–31 (monthly); clamped to the last day of short months
}

export const DEFAULT_SCHEDULE: CollectionSchedule = { frequency: 'daily' };

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Coerce arbitrary input into a valid schedule (defaults to daily). */
export function normalizeSchedule(raw: any): CollectionSchedule {
  const f = raw?.frequency;
  if (f === 'weekly' || f === 'biweekly') {
    let d = Number(raw?.dayOfWeek);
    if (!Number.isInteger(d) || d < 0 || d > 6) d = 1; // default Monday
    return { frequency: f, dayOfWeek: d };
  }
  if (f === 'monthly') {
    let d = Number(raw?.dayOfMonth);
    if (!Number.isInteger(d) || d < 1 || d > 31) d = 1;
    return { frequency: 'monthly', dayOfMonth: d };
  }
  return { frequency: 'daily' };
}

/**
 * Is a collection due on the given calendar date? Pass a Date already shifted to
 * the target local timezone and read with UTC getters (see localDate below).
 */
export function isDue(s: CollectionSchedule, d: Date): boolean {
  const dow = d.getUTCDay();
  switch (s.frequency) {
    case 'daily':
      return true;
    case 'weekly':
      return dow === (s.dayOfWeek ?? 1);
    case 'biweekly': {
      if (dow !== (s.dayOfWeek ?? 1)) return false;
      // Fixed fortnight cadence anchored to the Unix epoch.
      const dayNum = Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86400000);
      return Math.floor(dayNum / 7) % 2 === 0;
    }
    case 'monthly': {
      const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      return d.getUTCDate() === Math.min(s.dayOfMonth ?? 1, lastDay);
    }
  }
  return true;
}

/** "Now" as a calendar date in the given UTC offset (Costa Rica = -6), read via UTC getters. */
export function localDate(nowMs: number, utcOffsetHours = -6): Date {
  return new Date(nowMs + utcOffsetHours * 3600_000);
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** Human-readable summary, e.g. "Every night", "Every Monday", "Monthly on the 5th". */
export function describeSchedule(s: CollectionSchedule): string {
  switch (s.frequency) {
    case 'daily':
      return 'Every night';
    case 'weekly':
      return `Every ${DAYS[s.dayOfWeek ?? 1]}`;
    case 'biweekly':
      return `Every other ${DAYS[s.dayOfWeek ?? 1]}`;
    case 'monthly':
      return `Monthly on the ${ordinal(s.dayOfMonth ?? 1)}`;
  }
  return 'Every night';
}
