import type { JsonValue } from './document-receipt-types.js';
import type { HistoryMode } from '../history/types.js';
import type { MaadError } from '../errors.js';
import type { CreateResult } from './types.js';

export interface CreateContractRequest {
  contract: 'create-contract-v1';
  docType: string;
}

export interface CreateContract {
  contract: 'create-contract-v1';
  docType: string;
  schemaDigest: string;
  schemaProjection: 'create-schema-v1';
  contentProjection: 'document-content-v1';
  effectiveHistoryMode: HistoryMode;
  /** Complete, JSON-compatible input to the schema digest. */
  schemaContract: JsonValue;
}

export interface GuardedCreateRequest {
  contract: 'guarded-create-v1';
  docType: string;
  docId: string;
  fields: Record<string, JsonValue>;
  body: string;
  expectedSchemaDigest: string;
  expectedContentDigest: string;
  allowedHistoryModes: HistoryMode[];
}

/** Trusted in-process routing hooks; never part of the wire request. */
export interface GuardedCreateOptions {
  signal?: AbortSignal;
  validateAccess?: () => MaadError | null;
}

export interface GuardedCreateResult extends CreateResult {
  contract: 'guarded-create-v1';
  schemaDigest: string;
  contentDigest: string;
  effectiveHistoryMode: HistoryMode;
}
