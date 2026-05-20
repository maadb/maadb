// ============================================================================
// Engine Result Types — interfaces returned by engine operations
// ============================================================================

import type {
  DocId,
  DocType,
  FilePath,
  DocumentMatch,
  ObjectMatch,
  Relationship,
  ValidationResult,
  ValidationWarning,
  FilterCondition,
} from '../types.js';

export interface IndexResult {
  scanned: number;
  indexed: number;
  skipped: number;
  errors: import('../errors.js').MaadError[];
  /**
   * 0.7.4 (fup-2026-093) — types whose indexed-field set changed since the
   * previous indexAll. Docs of these types are force-rebuilt regardless of
   * file-hash skip; the names surface here so operators can see why a
   * "no change on disk" reindex still did work. Empty when nothing changed.
   */
  rebuiltTypes?: string[];
}

/**
 * 0.6.10 — Commit-durability signal attached to every single or bulk write
 * result. `writeDurable: true` means the file landed on disk AND either the
 * commit succeeded OR there was nothing to commit (noop on an idempotent
 * update). `writeDurable: false` means the file landed but the commit
 * failed — the caller should surface this to the client (MCP tools stamp
 * `_meta.write_durable: false` + `_meta.commit_failure`) so retries or
 * out-of-band reconciliation can happen. See fup-2026-066 for the original
 * symptom: bulk writes ack'ing durable while git held staged state.
 */
export interface CommitFailureDetail {
  code: string;
  message: string;
  action: 'create' | 'update' | 'delete';
}

export interface CreateResult {
  docId: DocId;
  filePath: FilePath;
  version: number;
  validation: ValidationResult;
  writeDurable: boolean;
  commitFailure?: CommitFailureDetail;
}

export interface BulkCreateInput {
  docType: string;
  fields: Record<string, unknown>;
  body?: string;
  docId?: string;
}

export interface BulkUpdateInput {
  docId: string;
  fields?: Record<string, unknown>;
  body?: string;
  appendBody?: string;
}

export interface BulkVerification {
  sampledIds: string[];
  sampled: number;
  passed: number;
  mismatches: Array<{ docId: string; field: string; expected: unknown; actual: unknown }>;
}

export interface BulkResult {
  succeeded: Array<{
    index: number;
    docId: string;
    docType: string;
    filePath: string;
    version: number;
    warnings?: ValidationWarning[];
  }>;
  failed: Array<{ index: number; docId: string | null; error: string }>;
  totalRequested: number;
  verification: BulkVerification;
  /**
   * Aggregated warnings across all succeeded records. Each entry carries the
   * same `field` / `message` / `code` as the per-record warnings but prefixed
   * with `{docId}.` in `field` so a caller reading the top-level channel can
   * trace each warning back to its record without cross-referencing.
   */
  warnings: ValidationWarning[];
  /**
   * 0.6.10 — Single-commit durability signal for the whole batch. `false`
   * means the per-record file writes succeeded but the final trailing
   * git commit failed, leaving staged changes uncommitted. Callers use
   * this to surface `write_durable: false` and trigger reconciliation.
   */
  writeDurable: boolean;
  commitFailure?: CommitFailureDetail;
}

export interface GetResult {
  docId: DocId;
  docType: DocType;
  version: number;
  updatedAt: string;
  depth: 'hot' | 'warm' | 'cold';
  frontmatter: Record<string, unknown>;
  block?: { id: string | null; heading: string; content: string } | undefined;
  body?: string | undefined;
}

export interface UpdateResult {
  docId: DocId;
  docType: DocType;
  version: number;
  changedFields: string[];
  validation: ValidationResult;
  writeDurable: boolean;
  commitFailure?: CommitFailureDetail;
}

export interface DeleteResult {
  docId: DocId;
  docType: DocType;
  mode: 'soft' | 'hard';
  filePath: FilePath;
  writeDurable: boolean;
  commitFailure?: CommitFailureDetail;
}

// ---- 0.7.10 — destructive cleanup primitives ------------------------------
// maad_bulk_delete / maad_delete_where: confirmed-mutation paths only call
// the engine when the caller passed confirm:true. Dry-run preview shape is
// owned by the MCP layer (it returns the would-affect docIds without
// invoking the engine), so the engine result here covers committed runs.

export interface BulkDeleteResult {
  succeeded: Array<{ docId: string; docType: string; filePath: string; mode: 'soft' | 'hard' }>;
  failed: Array<{ docId: string; error: string }>;
  totalRequested: number;
  writeDurable: boolean;
  commitFailure?: CommitFailureDetail;
}

// maad_purge_soft_deleted: hard-delete every soft-deleted record older than
// the retention threshold. Records here always purge in hard mode (file +
// row + cascade). `scanned` is the count of soft-deleted records that
// matched the retention threshold before maxRecords clipping; gives ops a
// signal when the cemetery is bigger than the cap.
export interface PurgeSoftDeletedResult {
  purged: Array<{ docId: string; docType: string; filePath: string }>;
  failed: Array<{ docId: string; error: string }>;
  scanned: number;
  retentionThresholdIso: string;
  writeDurable: boolean;
  commitFailure?: CommitFailureDetail;
}

// ---- 0.5.0 R5 — changes-since polling delta -------------------------------

export interface ChangesSinceQuery {
  cursor?: string | undefined;
  limit?: number | undefined;
  docTypes?: string[] | undefined;
}

export interface ChangeRecord {
  docId: string;
  docType: string;
  updatedAt: string;
  operation: 'create' | 'update';
}

export interface ChangesPage {
  changes: ChangeRecord[];
  nextCursor: string | null;
  hasMore: boolean;
}

// Internal — what the backend returns before cursor encoding.
export interface ChangesSinceParsedCursor {
  updatedAt: string;
  docId: string;
}

export interface FindResult {
  total: number;
  results: DocumentMatch[];
  /**
   * 0.7.1 — set when the engine capped the caller's requested `limit` to the
   * configured maximum. Consumers surface this on MCP responses as
   * `_meta.limit_clamped`. Omitted when no clamping occurred.
   */
  limitClamped?: { requested: number; applied: number };
}

export interface SearchResult {
  total: number;
  results: ObjectMatch[];
}

export interface AggregateQuery {
  docType?: DocType;
  groupBy: string;
  metric?: {
    field: string;
    op: 'count' | 'sum' | 'avg' | 'min' | 'max';
  };
  filters?: Record<string, import('../types.js').FilterCondition>;
  limit?: number;
}

export interface AggregateResult {
  groups: Array<{
    value: string;
    count: number;
    metric?: number | null;
  }>;
  total: number;
  totalMetric?: number | null;
  /**
   * 0.7.1 — set when the engine capped the caller's requested `limit` to the
   * configured maximum. Consumers surface this on MCP responses as
   * `_meta.limit_clamped`. Omitted when no clamping occurred.
   */
  limitClamped?: { requested: number; applied: number };
}

export interface JoinQuery {
  docType: DocType;
  refs: string[];
  fields?: string[];
  refFields?: Record<string, string[]>;
  filters?: Record<string, import('../types.js').FilterCondition>;
  limit?: number;
  offset?: number;
}

export interface JoinResultRow {
  docId: string;
  fields: Record<string, string>;
  refs: Record<string, { docId: string; fields: Record<string, string> } | null>;
}

export interface JoinResult {
  total: number;
  results: JoinResultRow[];
}

export interface RelatedResult {
  docId: DocId;
  outgoing: Array<{ docId: DocId; docType: DocType; field: string }>;
  incoming: Array<{ docId: DocId; docType: DocType; field: string }>;
}

export interface DescribeResult {
  registryTypes: Array<{
    type: string;
    path: string;
    idPrefix: string;
    schema: string;
    docCount: number;
  }>;
  extractionPrimitives: string[];
  totalDocuments: number;
  lastIndexedAt: string | null;
  /**
   * 0.7.0 — Subtype inventory moved here from maad_summary. Summary is an
   * orientation call (cheap, small); describe is the deep-dive call that
   * ships the inventory detail. Consumers that relied on summary.subtypeInventory
   * should switch to describe — the shape is unchanged.
   */
  subtypeInventory: Array<{
    primitive: string;
    subtype: string;
    count: number;
    topValues: string[];
  }>;
}

export interface SummaryResult {
  types: Array<{
    type: string;
    count: number;
    sampleIds: string[];
  }>;
  totalDocuments: number;
  totalObjects: number;
  totalRelationships: number;
  lastIndexedAt: string | null;
  warnings: {
    brokenRefs: number;
    validationErrors: number;
  };
  emptyProject: boolean;
  bootstrapHint: string | null;
  readOnly: boolean;
}

export interface GetFullResult {
  docId: DocId;
  docType: DocType;
  version: number;
  updatedAt: string;
  frontmatter: Record<string, unknown>;
  resolvedRefs: Record<string, { docId: string; name: string }>;
  objects: ObjectMatch[];
  related: {
    outgoing: Array<{ docId: string; docType: string; field: string }>;
    incoming: Array<{ docId: string; docType: string; field: string }>;
  };
  latestNote: { docId: string; summary: string; timestamp: string } | null;
}

export interface VerifyResult {
  grounded: boolean;
  claim: 'field' | 'count';
  expected: unknown;
  actual: unknown;
  source: { docId: string; filePath: string } | 'query';
}

// ----------------------------------------------------------------------------
// 0.7.10 — Integrity sweep result types.
// Walks every markdown file in scope, compares to the SQLite index, and
// surfaces five categories of drift. Read-only; the sweep never writes to
// documents, objects, relationships, or engine_meta. See
// docs/specs/0.7.10-integrity-cleanup.md.
// ----------------------------------------------------------------------------

export type IntegrityCategory =
  | 'missing_in_index'
  | 'missing_on_disk'
  | 'hash_drift'
  | 'schema_drift'
  | 'broken_refs';

export interface IntegrityFindingDetail {
  docId: string;
  docType: string;
  finding: IntegrityCategory;
  /** hash_drift: indexed hash. schema_drift: current pack schemaRef. */
  expected?: string;
  /** hash_drift: on-disk hash. schema_drift: stored schemaRef.
   *  broken_refs: { fieldName: [unresolved docIds] }. */
  actual?: string | Record<string, string[]>;
}

export interface IntegrityResult {
  scanned: number;
  healthy: number;
  findings: Record<IntegrityCategory, number>;
  scopeFilters: {
    docType: string | null;
    docId: string | null;
    filter: Record<string, FilterCondition> | null;
    categories: IntegrityCategory[] | null;
  };
  completedAt: string;
  durationMs: number;
  details?: IntegrityFindingDetail[];
}

export interface IntegrityQuery {
  docType?: DocType;
  docId?: DocId;
  filter?: Record<string, FilterCondition>;
  categories?: IntegrityCategory[];
  verbose?: boolean;
}

// ----------------------------------------------------------------------------
// 0.7.10 — maad_backup: named recovery anchors via annotated git tags.
// Tag format: maad-snapshot-YYYY-MM-DD-HHMM[-<label>] (UTC).
// ----------------------------------------------------------------------------

export interface BackupTag {
  tag: string;
  sha: string;
  message: string;
  createdAt: string;
}

export interface CreateBackupOptions {
  label?: string;
  message?: string;
}

export interface ListBackupsOptions {
  /** ISO8601 — only return tags created at or after this timestamp. */
  since?: string;
}

export interface SchemaInfoResult {
  type: string;
  idPrefix: string;
  schemaRef: string;
  fields: Array<{
    name: string;
    type: string;
    required: boolean;
    indexed: boolean;
    // 0.7.0 — fields below are optional; serialized only when non-null.
    // Pre-0.7.0 shipped null placeholders that bloated the response without
    // carrying information. Consumers reading these fields should treat
    // `undefined` and the previous `null` as equivalent.
    values?: string[];
    target?: string;
    format?: string;
    default?: unknown;
    // 0.6.7 — precision hints, omitted when null/unset.
    storePrecision?: string;
    onCoarser?: 'warn' | 'error';
    displayPrecision?: string;
  }>;
  // 0.7.0 — omitted when the schema has no template.
  templateHeadings?: Array<{ level: number; text: string }>;
}

export interface ValidationReport {
  total: number;
  valid: number;
  invalid: number;
  errors: Array<{ docId: DocId; errors: Array<{ field: string; message: string }> }>;
  /**
   * 0.6.7 — populated only when the caller passes `includePrecision: true`.
   * Informational; never counted as invalid. Each entry reports a date
   * field whose stored precision is coarser than the schema's declared
   * store_precision. Use to plan migrations without blocking reads.
   */
  precisionDrift?: Array<{
    docId: DocId;
    field: string;
    declared: string;
    actual: string;
  }>;
}
