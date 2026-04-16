// ============================================================================
// MAAD Core Types
// Every type, branded ID, IR, and constant used across the engine.
// ============================================================================

// --- Branded Identifiers ---------------------------------------------------

type Brand<T, B extends string> = T & { readonly __brand: B };

export type DocId = Brand<string, 'DocId'>;
export type DocType = Brand<string, 'DocType'>;
export type SchemaRef = Brand<string, 'SchemaRef'>;
export type FilePath = Brand<string, 'FilePath'>;
export type BlockId = Brand<string, 'BlockId'>;
export type CommitSha = Brand<string, 'CommitSha'>;

export function docId(raw: string): DocId {
  return raw as DocId;
}

export function docType(raw: string): DocType {
  return raw as DocType;
}

export function schemaRef(raw: string): SchemaRef {
  return raw as SchemaRef;
}

export function filePath(raw: string): FilePath {
  return raw as FilePath;
}

export function blockId(raw: string): BlockId {
  return raw as BlockId;
}

export function commitSha(raw: string): CommitSha {
  return raw as CommitSha;
}

// --- Extraction Primitives -------------------------------------------------

export const PRIMITIVES = [
  'entity',
  'date',
  'duration',
  'amount',
  'measure',
  'quantity',
  'percentage',
  'location',
  'identifier',
  'contact',
  'media',
] as const;

export type Primitive = typeof PRIMITIVES[number];

export const DEFAULT_SUBTYPE_MAP: Record<string, Primitive> = {
  // primitives self-map (so [[date:...]] resolves to 'date', not 'entity')
  entity: 'entity',
  date: 'date',
  duration: 'duration',
  amount: 'amount',
  measure: 'measure',
  quantity: 'quantity',
  percentage: 'percentage',
  location: 'location',
  identifier: 'identifier',
  contact: 'contact',
  media: 'media',

  // entity
  person: 'entity',
  org: 'entity',
  team: 'entity',
  product: 'entity',
  event: 'entity',
  role: 'entity',

  // date
  datetime: 'date',

  // duration
  timespan: 'duration',

  // amount
  currency: 'amount',
  price: 'amount',

  // measure
  weight: 'measure',
  height: 'measure',
  distance: 'measure',
  temperature: 'measure',
  dosage: 'measure',
  area: 'measure',

  // quantity
  count: 'quantity',

  // percentage
  rate: 'percentage',
  ratio: 'percentage',

  // location
  address: 'location',
  place: 'location',
  coordinates: 'location',

  // identifier
  case_number: 'identifier',
  invoice: 'identifier',
  license: 'identifier',
  reference: 'identifier',
  code: 'identifier',

  // contact
  email: 'contact',
  phone: 'contact',
  url: 'contact',

  // media
  image: 'media',
  video: 'media',
  audio: 'media',
  document: 'media',
  diagram: 'media',
};

export function buildSubtypeMap(
  defaults: Record<string, Primitive>,
  projectExtensions?: Record<string, string>,
): Record<string, Primitive> {
  const map = { ...defaults };
  if (projectExtensions) {
    for (const [subtype, primitive] of Object.entries(projectExtensions)) {
      if ((PRIMITIVES as readonly string[]).includes(primitive)) {
        map[subtype] = primitive as Primitive;
      }
    }
  }
  return map;
}

export function resolvePrimitive(
  subtype: string,
  map: Record<string, Primitive>,
): Primitive {
  return map[subtype] ?? 'entity';
}

// --- Source Location --------------------------------------------------------

export interface SourceLocation {
  file: FilePath;
  line: number;
  col: number;
}

// --- Parser IR (Stage 3 output) --------------------------------------------

export interface ParsedDocument {
  filePath: FilePath;
  fileHash: string;
  frontmatter: Record<string, unknown>;
  blocks: ParsedBlock[];
  valueCalls: ValueCall[];
  annotations: InlineAnnotation[];
}

export interface ParsedBlock {
  id: BlockId | null;
  heading: string;
  level: number;
  startLine: number;
  endLine: number;
}

export interface ValueCall {
  field: string;
  location: SourceLocation;
}

export interface InlineAnnotation {
  rawType: string;
  primitive: Primitive;
  value: string;
  label: string;
  location: SourceLocation;
}

// --- Schema Types ----------------------------------------------------------

export type FieldType =
  | 'string'
  | 'number'
  | 'date'
  | 'enum'
  | 'ref'
  | 'boolean'
  | 'list'
  | 'amount';

export interface FieldDefinition {
  name: string;
  type: FieldType;
  index: boolean;
  role: string | null;
  format: string | null;
  target: DocType | null;
  values: string[] | null;
  defaultValue: unknown;
  itemType: FieldType | null;
}

export interface TemplateHeading {
  level: number;
  text: string;
  id: string | null;
}

export interface SchemaDefinition {
  type: DocType;
  version: number;
  required: string[];
  fields: Map<string, FieldDefinition>;
  template: TemplateHeading[] | null;
}

// --- Registry Types --------------------------------------------------------

export interface RegistryType {
  name: DocType;
  path: string;
  idPrefix: string;
  schemaRef: SchemaRef;
  template: string | null;
}

export interface ExtractionConfig {
  subtypes: Record<string, Primitive>;
}

export interface Registry {
  types: Map<DocType, RegistryType>;
  extraction: ExtractionConfig;
  subtypeMap: Record<string, Primitive>;
}

// --- Schema Store ----------------------------------------------------------

export interface SchemaStore {
  schemas: Map<SchemaRef, SchemaDefinition>;
  getSchema(ref: SchemaRef): SchemaDefinition | undefined;
  getSchemaForType(type: DocType): SchemaDefinition | undefined;
}

// --- Bound Document (Stage 4 output) ---------------------------------------

export interface BoundDocument {
  parsed: ParsedDocument;
  docId: DocId;
  docType: DocType;
  schemaRef: SchemaRef;
  validatedFields: Record<string, ValidatedField>;
  validationResult: ValidationResult;
}

export interface ValidatedField {
  name: string;
  value: unknown;
  fieldType: FieldType;
  role: string | null;
  indexed: boolean;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  field: string;
  message: string;
  location: SourceLocation | null;
}

/**
 * Non-fatal signal emitted by the validator. Never blocks the write.
 * Surfaces in response `_meta.warnings[]` and in the ops log so agents can
 * self-correct and operators can see patterns.
 *
 * First use case is PRECISION_COARSER_THAN_DECLARED (0.6.7 Phase 4), but
 * the channel is reusable for future soft-validations — deprecated fields,
 * length hints, cross-field invariants, schema-evolution notices.
 */
export interface ValidationWarning {
  field: string;
  message: string;
  code: string;
  location: SourceLocation | null;
}

// --- Extraction Result (Stage 5 output) ------------------------------------

export interface ExtractionResult {
  document: BoundDocument;
  objects: ExtractedObject[];
  relationships: Relationship[];
}

export interface ExtractedObject {
  primitive: Primitive;
  subtype: string;
  value: string;
  normalizedValue: string | number | Record<string, unknown> | null;
  label: string;
  role: string | null;
  docId: DocId;
  location: SourceLocation;
  blockId: BlockId | null;
}

export interface Relationship {
  sourceDocId: DocId;
  targetDocId: DocId;
  field: string;
  relationType: 'ref' | 'mention';
}

// --- Backend Types ---------------------------------------------------------

export interface DocumentRecord {
  docId: DocId;
  docType: DocType;
  schemaRef: SchemaRef;
  filePath: FilePath;
  fileHash: string;
  version: number;
  deleted: boolean;
  indexedAt: string;
  updatedAt: string;
}

export type FilterCondition =
  | { op: 'eq'; value: unknown }
  | { op: 'neq'; value: unknown }
  | { op: 'gt' | 'gte' | 'lt' | 'lte'; value: number | string }
  | { op: 'in'; value: unknown[] }
  | { op: 'contains'; value: string };

export interface DocumentQuery {
  docType?: DocType;
  filters?: Record<string, FilterCondition>;
  fields?: string[];
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface ObjectQuery {
  primitive?: Primitive;
  subtype?: string;
  value?: string;
  contains?: string;
  range?: { gte?: string; gt?: string; lte?: string; lt?: string };
  docId?: DocId;
  limit?: number;
  offset?: number;
}

export interface DocumentMatch {
  docId: DocId;
  docType: DocType;
  filePath: FilePath;
  fields?: Record<string, string>;
}

export interface ObjectMatch {
  primitive: Primitive;
  subtype: string;
  value: string;
  normalizedValue: string | number | null;
  label: string;
  docId: DocId;
  sourceLine: number;
  blockId: BlockId | null;
}

export interface BackendStats {
  totalDocuments: number;
  totalObjects: number;
  totalRelationships: number;
  lastIndexedAt: string | null;
  documentCountByType: Record<string, number>;
}

// --- Git Types -------------------------------------------------------------

export interface ParsedCommit {
  action: string;
  docId: DocId;
  docType: DocType;
  detail: string;
  summary: string;
  sha: CommitSha;
  author: string;
  timestamp: string;
}

export interface AuditEntry {
  docId: DocId;
  docType: DocType;
  actions: number;
  lastAction: string;
  lastSummary: string;
  lastAuthor: string;
  lastTimestamp: string;
}

export interface DiffResult {
  docId: DocId;
  from: CommitSha;
  to: CommitSha;
  frontmatterChanges: Record<string, { from: unknown; to: unknown }>;
  bodyDiff: string;
}

export interface SnapshotResult {
  docId: DocId;
  commit: CommitSha;
  timestamp: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

// --- Verbatim Zones (parser internal) --------------------------------------

export interface VerbatimZone {
  startLine: number;
  endLine: number;
  startCol?: number | undefined;
  endCol?: number | undefined;
  inline: boolean;
}
