// ============================================================================
// Re-export from engine/ directory for backwards compatibility.
// All code lives in src/engine/*.ts — this file is a passthrough.
// ============================================================================

export { MaadEngine, type HealthReport } from './engine/index.js';

export type {
  IndexResult,
  CreateResult,
  GetResult,
  UpdateResult,
  DeleteResult,
  FindResult,
  SearchResult,
  RelatedResult,
  DescribeResult,
  SummaryResult,
  GetFullResult,
  SchemaInfoResult,
  ValidationReport,
} from './engine/types.js';
