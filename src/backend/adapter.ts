// ============================================================================
// Backend Adapter Interface
// Any backend implementation must satisfy this contract.
// ============================================================================

import type {
  DocId,
  DocType,
  FilePath,
  DocumentRecord,
  DocumentQuery,
  ObjectQuery,
  DocumentMatch,
  ObjectMatch,
  ExtractedObject,
  Relationship,
  ParsedBlock,
  BackendStats,
} from '../types.js';

export interface MaadBackend {
  // Lifecycle
  init(): void;
  close(): void;

  // Write operations (called during materialize stage)
  putDocument(doc: DocumentRecord): void;
  putObjects(docId: DocId, objects: ExtractedObject[]): void;
  putRelationships(docId: DocId, relations: Relationship[]): void;
  putBlocks(docId: DocId, blocks: ParsedBlock[]): void;
  putFieldIndex(docId: DocId, fields: Array<{ name: string; value: string; numericValue: number | null; type: string }>): void;

  // Read operations (called by MCP tools)
  getDocument(docId: DocId): DocumentRecord | null;
  getDocumentByPath(path: FilePath): DocumentRecord | null;
  findDocuments(query: DocumentQuery): DocumentMatch[];
  findObjects(query: ObjectQuery): ObjectMatch[];
  getRelationships(docId: DocId, direction: 'outgoing' | 'incoming' | 'both'): Relationship[];
  getBlocks(docId: DocId): ParsedBlock[];

  // Maintenance
  removeDocument(docId: DocId): void;
  getFileHash(path: FilePath): string | null;
  getAllFileHashes(): Map<FilePath, string>;
  getStats(): BackendStats;

  // Batch write (wraps all puts in a transaction for a single document)
  materializeDocument(
    doc: DocumentRecord,
    objects: ExtractedObject[],
    relationships: Relationship[],
    blocks: ParsedBlock[],
    fieldIndex: Array<{ name: string; value: string; numericValue: number | null; type: string }>,
  ): void;
}
