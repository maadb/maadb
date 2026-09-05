import type { DocumentQuery, FilterCondition } from '../../types.js';

/** Shared live-document eligibility; no ordering or result limit. */
export function buildDocumentScope(query: DocumentQuery): { where: string; params: unknown[] } {
  const conditions: string[] = ['d.deleted = 0'];
  const params: unknown[] = [];

  if (query.docType) {
    conditions.push('d.doc_type = ?');
    params.push(query.docType as string);
  }

  if (query.filters) {
    for (const [field, condition] of Object.entries(query.filters)) {
      applyFieldFilters(field, condition, conditions, params);
    }
  }

  return { where: conditions.join(' AND '), params };
}

function normalizeFilter(condition: FilterCondition | string | unknown): FilterCondition {
  // Shorthand: "value" → { op: 'eq', value: "value" }
  if (typeof condition === 'string') return { op: 'eq', value: condition };
  if (typeof condition === 'number') return { op: 'eq', value: condition };
  if (typeof condition === 'object' && condition !== null && 'op' in condition) return condition as FilterCondition;
  // Fallback: treat as eq with string coercion
  return { op: 'eq', value: String(condition) };
}

// 0.7.1 R2 — apply per-field filters to a SQL conditions/params pair. Accepts
// either the legacy single-filter shape (scalar, single op) or the expanded
// array-of-ops shape produced by the engine-layer `expandFilters`. All atomic
// conditions AND-combine at the SQL layer via separate `d.doc_id IN (...)` clauses.
export function applyFieldFilters(
  field: string,
  raw: unknown,
  conditions: string[],
  params: unknown[],
): void {
  const atomics: unknown[] = Array.isArray(raw) ? raw : [raw];
  const positive: Array<{ sql: string; values: unknown[] }> = [];
  for (const c of atomics) {
    const normalized = normalizeFilter(c);
    if (normalized.op === 'neq') {
      // Multi-valued fields use NONE semantics for neq. `EXISTS(value != x)`
      // is wrong for [x, y] because y makes the document match even though x
      // is present. Retain the historical requirement that the field exists.
      conditions.push('d.doc_id IN (SELECT doc_id FROM field_index WHERE field_name = ?)');
      params.push(field);
      conditions.push('d.doc_id NOT IN (SELECT doc_id FROM field_index WHERE field_name = ? AND field_value = ?)');
      params.push(field, String(normalized.value));
      continue;
    }
    const { sql, values } = buildFilterSQL(field, c);
    positive.push({ sql, values });
  }
  if (positive.length > 0) {
    // All operators on one field must be satisfied by the same indexed value.
    // This matters for lists: [1, 20] must not satisfy gte 10 AND lte 5 by
    // distributing the two predicates across different items.
    conditions.push(`d.doc_id IN (SELECT doc_id FROM field_index WHERE ${positive.map(p => `(${p.sql})`).join(' AND ')})`);
    params.push(...positive.flatMap(p => p.values));
  }
}

export function buildFilterSQL(field: string, rawCondition: FilterCondition | string | unknown): { sql: string; values: unknown[] } {
  const condition = normalizeFilter(rawCondition);
  // For range operators, use numeric_value when the value is numeric (handles number fields correctly)
  // For dates, field_value as ISO strings already sort correctly
  const isNumericRange = (condition.op === 'gt' || condition.op === 'gte' || condition.op === 'lt' || condition.op === 'lte')
    && typeof condition.value === 'number';

  switch (condition.op) {
    case 'eq':
      return { sql: 'field_name = ? AND field_value = ?', values: [field, String(condition.value)] };
    case 'neq':
      return { sql: 'field_name = ? AND field_value != ?', values: [field, String(condition.value)] };
    case 'gt':
      if (isNumericRange) {
        return { sql: 'field_name = ? AND numeric_value > ?', values: [field, condition.value] };
      }
      return { sql: 'field_name = ? AND field_value > ?', values: [field, String(condition.value)] };
    case 'gte':
      if (isNumericRange) {
        return { sql: 'field_name = ? AND numeric_value >= ?', values: [field, condition.value] };
      }
      return { sql: 'field_name = ? AND field_value >= ?', values: [field, String(condition.value)] };
    case 'lt':
      if (isNumericRange) {
        return { sql: 'field_name = ? AND numeric_value < ?', values: [field, condition.value] };
      }
      return { sql: 'field_name = ? AND field_value < ?', values: [field, String(condition.value)] };
    case 'lte':
      if (isNumericRange) {
        return { sql: 'field_name = ? AND numeric_value <= ?', values: [field, condition.value] };
      }
      return { sql: 'field_name = ? AND field_value <= ?', values: [field, String(condition.value)] };
    case 'in': {
      const placeholders = condition.value.map(() => '?').join(', ');
      return { sql: `field_name = ? AND field_value IN (${placeholders})`, values: [field, ...condition.value.map(String)] };
    }
    case 'contains':
      return { sql: 'field_name = ? AND field_value LIKE ?', values: [field, `%${condition.value}%`] };
    case 'between':
      // Defensive: `between` is a compound shortcut normalized to [gte, lte] by
      // the engine layer's `expandFilters` (src/engine/reads.ts). Reaching this
      // branch means filters bypassed engine normalization — caller layering bug.
      throw new Error(`Unexpected 'between' filter at backend layer — engine must expand via expandFilters before passing to backend`);
  }
}

