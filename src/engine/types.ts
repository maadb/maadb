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
} from '../types.js';

export interface IndexResult {
  scanned: number;
  indexed: number;
  skipped: number;
  errors: import('../errors.js').MaadError[];
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
  subtypeInventory: Array<{
    primitive: string;
    subtype: string;
    count: number;
    topValues: string[];
  }>;
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

export interface SchemaInfoResult {
  type: string;
  idPrefix: string;
  schemaRef: string;
  fields: Array<{
    name: string;
    type: string;
    required: boolean;
    indexed: boolean;
    values: string[] | null;
    target: string | null;
    format: string | null;
    default: unknown;
    // 0.6.7 — omitted when null/unset; only present on date fields with
    // declared precision. Consumers may render using displayPrecision.
    storePrecision?: string;
    onCoarser?: 'warn' | 'error';
    displayPrecision?: string;
  }>;
  templateHeadings: Array<{ level: number; text: string }> | null;
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
