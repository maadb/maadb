import type { HistoryMode } from '../history/types.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface DocumentReceiptRequest {
  contract: 'document-persistence-v1';
  docType: string;
  docId: string;
  expectedContentDigest?: string | undefined;
}
export interface DocumentReceipt {
  contract: 'document-persistence-v1';
  engineVersion: string;
  project: string;
  docId: string;
  docType: string;
  observedAt: string;
  effectiveHistoryMode: HistoryMode;
  projection: 'document-content-v1';
  expectedContentDigest: string | null;
  status: 'committed_content_available' | 'unverified';
  reason: null | 'index_missing' | 'index_identity_mismatch' | 'working_tree_missing'
    | 'working_tree_unreadable' | 'working_tree_changed' | 'working_tree_diverged'
    | 'history_unavailable' | 'uncommitted' | 'committed_payload_mismatch';
  index: { state: 'present' | 'missing' | 'identity_mismatch' };
  workingTree: {
    state: 'matches_committed' | 'diverged' | 'missing' | 'unreadable' | 'changed' | 'not_checked';
    rawSha256: string | null;
    contentDigest: string | null;
  };
  committed: null | {
    evidenceKind: 'git_commit_visible';
    objectFormat: 'sha1' | 'sha256';
    commitOid: string;
    treeOid: string;
    blobOid: string;
    rawSha256: string;
    byteLength: number;
    rawMarkdown: string;
    frontmatter: Record<string, JsonValue>;
    body: string;
    contentDigest: string;
  };
  expectedDigestMatch: boolean | null;
}
