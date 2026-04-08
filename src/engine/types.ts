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
} from '../types.js';

export interface IndexResult {
  scanned: number;
  indexed: number;
  skipped: number;
  errors: import('../errors.js').MaadError[];
}

export interface CreateResult {
  docId: DocId;
  filePath: FilePath;
  version: number;
  validation: ValidationResult;
}

export interface GetResult {
  docId: DocId;
  docType: DocType;
  depth: 'hot' | 'warm' | 'cold';
  frontmatter: Record<string, unknown>;
  block?: { id: string | null; heading: string; content: string } | undefined;
  body?: string | undefined;
}

export interface UpdateResult {
  docId: DocId;
  version: number;
  changedFields: string[];
  validation: ValidationResult;
}

export interface DeleteResult {
  docId: DocId;
  mode: 'soft' | 'hard';
  filePath: FilePath;
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
}

export interface GetFullResult {
  docId: DocId;
  docType: DocType;
  frontmatter: Record<string, unknown>;
  resolvedRefs: Record<string, { docId: string; name: string }>;
  objects: ObjectMatch[];
  related: {
    outgoing: Array<{ docId: string; docType: string; field: string }>;
    incoming: Array<{ docId: string; docType: string; field: string }>;
  };
  latestNote: { docId: string; summary: string; timestamp: string } | null;
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
  }>;
  templateHeadings: Array<{ level: number; text: string }> | null;
}

export interface ValidationReport {
  total: number;
  valid: number;
  invalid: number;
  errors: Array<{ docId: DocId; errors: Array<{ field: string; message: string }> }>;
}
