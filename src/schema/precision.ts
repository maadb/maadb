// ============================================================================
// Datetime precision detection
// Honors the LITERAL string's precision, not the parsed Date object.
// "2026-04-16T00:00:00Z" is second-precision (because seconds are written),
// not day-precision-padded-to-midnight.
// ============================================================================

export type Precision =
  | 'year'
  | 'month'
  | 'day'
  | 'hour'
  | 'minute'
  | 'second'
  | 'millisecond';

const PRECISION_RANK: Record<Precision, number> = {
  year: 0,
  month: 1,
  day: 2,
  hour: 3,
  minute: 4,
  second: 5,
  millisecond: 6,
};

const VALID_PRECISIONS: readonly Precision[] = [
  'year',
  'month',
  'day',
  'hour',
  'minute',
  'second',
  'millisecond',
] as const;

export function isPrecision(v: unknown): v is Precision {
  return typeof v === 'string' && (VALID_PRECISIONS as readonly string[]).includes(v);
}

export function detectPrecision(iso: string): Precision | null {
  // Timezone suffix (Z, +HH:MM, -HH:MM) does not change precision classification.
  const stripped = iso.replace(/(Z|[+-]\d{2}:\d{2})$/, '');

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+$/.test(stripped)) return 'millisecond';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(stripped)) return 'second';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(stripped)) return 'minute';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(stripped)) return 'hour';
  if (/^\d{4}-\d{2}-\d{2}$/.test(stripped)) return 'day';
  if (/^\d{4}-\d{2}$/.test(stripped)) return 'month';
  if (/^\d{4}$/.test(stripped)) return 'year';

  return null;
}

export function comparePrecision(a: Precision, b: Precision): -1 | 0 | 1 {
  const ra = PRECISION_RANK[a];
  const rb = PRECISION_RANK[b];
  if (ra < rb) return -1;
  if (ra > rb) return 1;
  return 0;
}

export function isCoarserThan(actual: Precision, declared: Precision): boolean {
  return comparePrecision(actual, declared) < 0;
}

export function isFinerThan(actual: Precision, declared: Precision): boolean {
  return comparePrecision(actual, declared) > 0;
}
