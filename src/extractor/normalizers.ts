// ============================================================================
// Normalizers
// One normalizer per primitive. Each returns a typed result or null.
// ============================================================================

import type { Primitive } from '../types.js';

// --- Entity, Location, Identifier ------------------------------------------

export function normalizeString(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

// --- Date ------------------------------------------------------------------

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}/;

const MONTH_NAMES: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12',
  jan: '01', feb: '02', mar: '03', apr: '04',
  jun: '06', jul: '07', aug: '08',
  sep: '09', oct: '10', nov: '11', dec: '12',
};

export function normalizeDate(value: string): string | null {
  const trimmed = value.trim();

  // Already ISO
  if (ISO_DATE_REGEX.test(trimmed)) return trimmed;

  // "March 28, 2026" or "Mar 28, 2026"
  const longMatch = /^([a-zA-Z]+)\s+(\d{1,2}),?\s+(\d{4})$/.exec(trimmed);
  if (longMatch) {
    const month = MONTH_NAMES[longMatch[1]!.toLowerCase()];
    if (month) {
      const day = longMatch[2]!.padStart(2, '0');
      return `${longMatch[3]}-${month}-${day}`;
    }
  }

  // "28 March 2026"
  const euroMatch = /^(\d{1,2})\s+([a-zA-Z]+)\s+(\d{4})$/.exec(trimmed);
  if (euroMatch) {
    const month = MONTH_NAMES[euroMatch[2]!.toLowerCase()];
    if (month) {
      const day = euroMatch[1]!.padStart(2, '0');
      return `${euroMatch[3]}-${month}-${day}`;
    }
  }

  // "M-DD-YY" or "MM-DD-YY" (US short)
  const shortMatch = /^(\d{1,2})[-/](\d{1,2})[-/](\d{2})$/.exec(trimmed);
  if (shortMatch) {
    const month = shortMatch[1]!.padStart(2, '0');
    const day = shortMatch[2]!.padStart(2, '0');
    const yearShort = parseInt(shortMatch[3]!, 10);
    const year = yearShort >= 0 && yearShort <= 49 ? 2000 + yearShort : 1900 + yearShort;
    return `${year}-${month}-${day}`;
  }

  // "MM/DD/YYYY"
  const usMatch = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(trimmed);
  if (usMatch) {
    const month = usMatch[1]!.padStart(2, '0');
    const day = usMatch[2]!.padStart(2, '0');
    return `${usMatch[3]}-${month}-${day}`;
  }

  return null;
}

// --- Duration --------------------------------------------------------------

const DURATION_UNITS: Record<string, string> = {
  second: 'S', seconds: 'S', sec: 'S', secs: 'S', s: 'S',
  minute: 'M', minutes: 'M', min: 'M', mins: 'M',
  hour: 'H', hours: 'H', hr: 'H', hrs: 'H', h: 'H',
  day: 'D', days: 'D', d: 'D',
  week: 'W', weeks: 'W', wk: 'W', wks: 'W', w: 'W',
  month: 'M_DATE', months: 'M_DATE', mo: 'M_DATE',
  year: 'Y', years: 'Y', yr: 'Y', yrs: 'Y', y: 'Y',
};

const DATE_UNITS = new Set(['Y', 'M_DATE', 'W', 'D']);

export function normalizeDuration(value: string): string | null {
  const trimmed = value.trim().toLowerCase();

  // Already ISO 8601 duration
  if (/^P[\dTHMSWY.]+$/i.test(trimmed)) return trimmed.toUpperCase();

  // Parse "3 hours", "2 weeks", "1 hour 30 minutes"
  const parts = [...trimmed.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/g)];
  if (parts.length === 0) return null;

  let datePart = '';
  let timePart = '';

  for (const part of parts) {
    const num = part[1]!;
    const unitStr = part[2]!;
    const unit = DURATION_UNITS[unitStr];
    if (!unit) return null;

    if (unit === 'M_DATE') {
      datePart += `${num}M`;
    } else if (DATE_UNITS.has(unit)) {
      datePart += `${num}${unit}`;
    } else {
      timePart += `${num}${unit}`;
    }
  }

  if (datePart === '' && timePart === '') return null;

  let result = 'P';
  if (datePart) result += datePart;
  if (timePart) result += `T${timePart}`;

  return result;
}

// --- Amount ----------------------------------------------------------------

const CURRENCY_SYMBOLS: Record<string, string> = {
  '$': 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '¥': 'JPY',
  '₹': 'INR',
  '₩': 'KRW',
  'C$': 'CAD',
  'A$': 'AUD',
};

export function normalizeAmount(value: string): { amount: number; currency: string } | null {
  const trimmed = value.trim();

  // "100.00 USD" or "-100.00 USD"
  const explicitMatch = /^(-?[\d,]+(?:\.\d+)?)\s+([A-Z]{3})$/.exec(trimmed);
  if (explicitMatch) {
    const amount = parseFloat(explicitMatch[1]!.replace(/,/g, ''));
    if (isNaN(amount)) return null;
    return { amount, currency: explicitMatch[2]! };
  }

  // "$100" or "€50.00"
  for (const [symbol, currency] of Object.entries(CURRENCY_SYMBOLS)) {
    if (trimmed.startsWith(symbol)) {
      const numStr = trimmed.slice(symbol.length).replace(/,/g, '').trim();
      const amount = parseFloat(numStr);
      if (!isNaN(amount)) return { amount, currency };
    }
  }

  return null;
}

// --- Measure ---------------------------------------------------------------

export function normalizeMeasure(value: string): { value: number; unit: string } | null {
  const trimmed = value.trim();

  // "500mg", "6 feet", "98.6°F", "1200 sqft"
  // Unit must start with a non-digit character
  const match = /^([\d,]+(?:\.\d+)?)\s*([^\d\s].*)$/.exec(trimmed);
  if (!match) return null;

  const num = parseFloat(match[1]!.replace(/,/g, ''));
  if (isNaN(num)) return null;

  const unit = match[2]!.trim();
  if (unit.length === 0) return null;

  return { value: num, unit };
}

// --- Quantity --------------------------------------------------------------

export function normalizeQuantity(value: string): number | null {
  const trimmed = value.trim().replace(/,/g, '');
  const num = parseFloat(trimmed);
  return isNaN(num) ? null : num;
}

// --- Percentage ------------------------------------------------------------

export function normalizePercentage(value: string): number | null {
  const trimmed = value.trim().toLowerCase();

  // "15%" or "15 %"
  const pctMatch = /^([\d.]+)\s*%$/.exec(trimmed);
  if (pctMatch) {
    const num = parseFloat(pctMatch[1]!);
    return isNaN(num) ? null : num / 100;
  }

  // "85 percent"
  const wordMatch = /^([\d.]+)\s*percent$/.exec(trimmed);
  if (wordMatch) {
    const num = parseFloat(wordMatch[1]!);
    return isNaN(num) ? null : num / 100;
  }

  // Already decimal "0.15"
  const num = parseFloat(trimmed);
  if (!isNaN(num) && num >= 0 && num <= 1) return num;

  return null;
}

// --- Contact ---------------------------------------------------------------

export function normalizeContact(value: string, subtype?: string | undefined): string {
  const trimmed = value.trim();

  const detectedType = subtype ?? detectContactType(trimmed);

  switch (detectedType) {
    case 'email':
      return trimmed.toLowerCase();
    case 'phone':
      // Best-effort: strip non-digit except leading +
      return trimmed.startsWith('+')
        ? '+' + trimmed.slice(1).replace(/\D/g, '')
        : trimmed.replace(/\D/g, '');
    case 'url':
      // Ensure protocol
      if (!/^https?:\/\//i.test(trimmed)) return `https://${trimmed}`;
      return trimmed;
    default:
      return trimmed;
  }
}

function detectContactType(value: string): string {
  if (value.includes('@') && value.includes('.')) return 'email';
  if (/^(\+?\d[\d\s\-().]{6,})$/.test(value)) return 'phone';
  if (/^(https?:\/\/|www\.)/i.test(value)) return 'url';
  return 'unknown';
}

// --- Media -----------------------------------------------------------------

const MEDIA_EXTENSIONS: Record<string, string> = {
  // image
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image',
  svg: 'image', bmp: 'image', tiff: 'image', ico: 'image',
  // video
  mp4: 'video', mov: 'video', avi: 'video', mkv: 'video', webm: 'video', wmv: 'video',
  // audio
  mp3: 'audio', wav: 'audio', ogg: 'audio', flac: 'audio', aac: 'audio', m4a: 'audio',
  // document
  pdf: 'document', doc: 'document', docx: 'document', xls: 'document',
  xlsx: 'document', ppt: 'document', pptx: 'document', txt: 'document', csv: 'document',
  // diagram
  drawio: 'diagram', mermaid: 'diagram', puml: 'diagram',
};

export function normalizeMedia(value: string): { path: string; mediaType: string } | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const ext = trimmed.split('.').pop()?.toLowerCase();
  const mediaType = (ext && MEDIA_EXTENSIONS[ext]) ?? 'unknown';

  return { path: trimmed, mediaType };
}

// --- Dispatch --------------------------------------------------------------

export type NormalizedValue = string | number | Record<string, unknown> | null;

export function normalize(
  primitive: Primitive,
  value: string,
  subtype?: string | undefined,
): NormalizedValue {
  switch (primitive) {
    case 'entity':      return normalizeString(value);
    case 'date':        return normalizeDate(value);
    case 'duration':    return normalizeDuration(value);
    case 'amount':      return normalizeAmount(value) as Record<string, unknown> | null;
    case 'measure':     return normalizeMeasure(value) as Record<string, unknown> | null;
    case 'quantity':    return normalizeQuantity(value);
    case 'percentage':  return normalizePercentage(value);
    case 'location':    return normalizeString(value);
    case 'identifier':  return normalizeString(value);
    case 'contact':     return normalizeContact(value, subtype);
    case 'media':       return normalizeMedia(value) as Record<string, unknown> | null;
  }
}
