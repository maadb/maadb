// ============================================================================
// Operation Journal — tracks pending writes for crash recovery
// Stored in _backend/journal.json (a snapshot) and _backend/journal.log (the
// changes made since it). Reconciled on engine startup.
// ============================================================================

import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { CommitOptions } from '../git/index.js';

export interface JournalEntry {
  id: string;
  op: 'create' | 'update' | 'delete';
  docId: string;
  filePath: string;
  tempPath?: string | undefined;
  files?: string[] | undefined;
  commitId?: string | undefined;
  gitBoundarySha?: string | undefined;
  snapshotTag?: string | undefined;
  timestamp: string;
  status: 'pending' | 'file_written' | 'indexed' | 'committed';
}

// Bulk writes bind one commit to every entry, so the commit (and its file list)
// is stored once and entries reference it. Before version 2 the file was a bare
// entry array with the commit inlined on each entry; that form still loads.
// Each change is one appended line, so a state change costs what it changes and
// not the size of the journal. Records at or below the snapshot's seq are
// already in it. Versions before 3 have no log.
const JOURNAL_VERSION = 3;
const COMPACT_MIN_BYTES = 1024 * 1024;
const COMPACT_IDLE_BYTES = 64 * 1024;
const SHARING_RETRIES = process.platform === 'win32' ? 5 : 0;

type JournalPatch = Partial<Pick<JournalEntry, 'status' | 'files' | 'gitBoundarySha' | 'snapshotTag'>>;

type JournalChange =
  | { kind: 'begin'; entry: JournalEntry }
  | { kind: 'patch'; ids: string[]; patch: JournalPatch }
  | { kind: 'bind'; ids: string[]; commitId: string; commit: CommitOptions }
  | { kind: 'drop'; ids: string[] };

type StoredEntry = JournalEntry & { commit?: CommitOptions | undefined };

function isJournalEntry(value: unknown): value is StoredEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return ['id', 'docId', 'filePath', 'timestamp'].every(key => typeof entry[key] === 'string')
    && typeof entry.op === 'string' && ['create', 'update', 'delete'].includes(entry.op)
    && typeof entry.status === 'string' && ['pending', 'file_written', 'indexed', 'committed'].includes(entry.status)
    && ['tempPath', 'commitId', 'gitBoundarySha', 'snapshotTag'].every(key => entry[key] === undefined || typeof entry[key] === 'string')
    && (entry.files === undefined || (Array.isArray(entry.files) && entry.files.every(file => typeof file === 'string')))
    && (entry.commit === undefined || isCommitOptions(entry.commit));
}

function isCommitOptions(value: unknown): value is CommitOptions {
  if (!value || typeof value !== 'object') return false;
  const commit = value as Record<string, unknown>;
  return ['action', 'docId', 'docType', 'detail', 'summary'].every(key => typeof commit[key] === 'string')
    && ['create', 'update', 'delete'].includes(commit.action as string)
    && Array.isArray(commit.files) && commit.files.every(file => typeof file === 'string');
}

function isJournalChange(value: unknown): value is JournalChange {
  if (!value || typeof value !== 'object') return false;
  const change = value as Record<string, unknown>;
  if (change.kind === 'begin') return isJournalEntry(change.entry);
  if (!Array.isArray(change.ids) || !change.ids.every(id => typeof id === 'string')) return false;
  if (change.kind === 'patch') return !!change.patch && typeof change.patch === 'object';
  if (change.kind === 'bind') return typeof change.commitId === 'string' && isCommitOptions(change.commit);
  return change.kind === 'drop';
}

function readIfPresent(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export class OperationJournal {
  private journalPath: string;
  private logPath: string;
  private entries = new Map<string, JournalEntry>();
  private commits = new Map<string, CommitOptions>();
  private seq = 0;
  private logBytes = 0;
  private compactAt = COMPACT_MIN_BYTES;
  // Also set after a failed append: a partial line must stay last, so nothing
  // is appended until a snapshot replaces the log.
  private needsSnapshot = true;

  constructor(backendDir: string) {
    this.journalPath = path.join(backendDir, 'journal.json');
    this.logPath = path.join(backendDir, 'journal.log');
    this.load();
  }

  private load(): void {
    const raw = readIfPresent(this.journalPath);
    if (raw !== undefined) {
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch {
        throw new Error('Invalid operation journal JSON; preserve journal.json and journal.log and repair them before restarting');
      }
      this.restore(parsed);
    }
    // Older versions never write the log, so one beside their journal is stale.
    if (raw === undefined || !this.needsSnapshot) this.replay();
  }

  private restore(parsed: unknown): void {
    const invalid = () => new Error('Invalid operation journal entries; preserve journal.json and journal.log and repair them before restarting');
    let stored: unknown;
    const commits = new Map<string, CommitOptions>();
    if (Array.isArray(parsed)) {
      stored = parsed;
    } else {
      const file = parsed as { version?: unknown; seq?: unknown; commits?: unknown; entries?: unknown } | null;
      if ((file?.version !== 2 && file?.version !== JOURNAL_VERSION) || !file.commits || typeof file.commits !== 'object') throw invalid();
      if (file.version === JOURNAL_VERSION) {
        if (!Number.isSafeInteger(file.seq)) throw invalid();
        this.seq = file.seq as number;
        this.needsSnapshot = false;
      }
      for (const [id, commit] of Object.entries(file.commits)) {
        if (!isCommitOptions(commit)) throw invalid();
        commits.set(id, commit);
      }
      stored = file.entries;
    }
    if (!Array.isArray(stored) || !stored.every(isJournalEntry)) throw invalid();

    const interned = new Map<string, string>();
    for (const { commit, ...entry } of stored) {
      if (commit) {
        const key = JSON.stringify(commit);
        let commitId = interned.get(key);
        if (commitId === undefined) {
          commitId = randomUUID();
          interned.set(key, commitId);
          commits.set(commitId, commit);
        }
        this.entries.set(entry.id, { ...entry, commitId });
        continue;
      }
      if (entry.commitId !== undefined && !commits.has(entry.commitId)) throw invalid();
      this.entries.set(entry.id, entry);
    }
    this.commits = commits;
  }

  private replay(): void {
    const raw = readIfPresent(this.logPath);
    if (raw === undefined) return;
    const invalid = () => new Error('Invalid operation journal log; preserve journal.json and journal.log and repair them before restarting');
    this.logBytes = Buffer.byteLength(raw);
    // Text after the last newline is an append that never finished, so its
    // caller never saw it succeed.
    const end = raw.lastIndexOf('\n');
    if (end !== raw.length - 1) this.needsSnapshot = true;

    const base = this.seq;
    for (const line of raw.slice(0, end + 1).split('\n')) {
      if (line === '') continue;
      let record: unknown;
      try { record = JSON.parse(line); } catch { throw invalid(); }
      if (!isJournalChange(record)) throw invalid();
      const seq = (record as { seq?: unknown }).seq;
      if (typeof seq !== 'number' || !Number.isSafeInteger(seq)) throw invalid();
      if (seq <= base) continue;
      this.apply(record);
      this.seq = Math.max(this.seq, seq);
    }
    if (![...this.entries.values()].every(isJournalEntry)) throw invalid();
  }

  private apply(change: JournalChange): void {
    switch (change.kind) {
      case 'begin':
        this.entries.set(change.entry.id, change.entry);
        break;
      case 'patch':
        for (const id of change.ids) {
          const entry = this.entries.get(id);
          if (entry) Object.assign(entry, change.patch);
        }
        break;
      case 'bind':
        for (const id of change.ids) {
          const entry = this.entries.get(id);
          if (entry) entry.commitId = change.commitId;
        }
        this.commits.set(change.commitId, change.commit);
        this.pruneCommits();
        break;
      case 'drop':
        for (const id of change.ids) this.entries.delete(id);
        this.pruneCommits();
        break;
    }
  }

  private pruneCommits(): void {
    const live = new Set([...this.entries.values()].map(entry => entry.commitId));
    for (const id of this.commits.keys()) {
      if (!live.has(id)) this.commits.delete(id);
    }
  }

  // Memory changes only after the change is on disk, so a failed write leaves
  // no unpersisted recovery state for a later operation or shutdown flush.
  private record(change: JournalChange): void {
    if (this.needsSnapshot) this.writeSnapshot();
    const line = `${JSON.stringify({ seq: this.seq + 1, ...change })}\n`;
    try {
      retrySharing(() => appendFileSync(this.logPath, line, 'utf-8'), SHARING_RETRIES);
    } catch (error) {
      this.needsSnapshot = true;
      throw error;
    }
    this.seq += 1;
    this.logBytes += Buffer.byteLength(line);
    this.apply(change);
    if (this.logBytes >= this.compactAt || (this.entries.size === 0 && this.logBytes >= COMPACT_IDLE_BYTES)) {
      this.compact();
    }
  }

  private writeSnapshot(): void {
    const next = JSON.stringify({
      version: JOURNAL_VERSION,
      seq: this.seq,
      commits: Object.fromEntries(this.commits),
      entries: [...this.entries.values()],
    }, null, 2);
    atomicWriteSync(this.journalPath, next, SHARING_RETRIES);
    this.compactAt = Math.max(COMPACT_MIN_BYTES, next.length * 2);
    // The snapshot's seq already covers the log, but a partial line may be in
    // it, so a log that cannot be removed fails the write instead of growing.
    this.needsSnapshot = true;
    retrySharing(() => rmSync(this.logPath, { force: true }), SHARING_RETRIES);
    this.logBytes = 0;
    this.needsSnapshot = false;
  }

  // Only runs on a clean log. The change that triggered this is already durable
  // in it, so a failed compaction is not a failed write.
  private compact(): void {
    try {
      this.writeSnapshot();
    } catch {
      this.needsSnapshot = false;
      this.compactAt = this.logBytes * 2;
    }
  }

  begin(op: JournalEntry['op'], docId: string, filePath: string, tempPath?: string): string {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.record({ kind: 'begin', entry: {
      id,
      op,
      docId,
      filePath,
      tempPath,
      timestamp: new Date().toISOString(),
      status: 'pending',
    } });
    return id;
  }

  advance(id: string, status: JournalEntry['status']): void {
    if (this.entries.has(id)) this.record({ kind: 'patch', ids: [id], patch: { status } });
  }

  setFiles(id: string, files: string[]): void {
    if (this.entries.has(id)) this.record({ kind: 'patch', ids: [id], patch: { files: [...new Set(files)] } });
  }

  bindCommit(ids: string[], commit: CommitOptions): void {
    const known = ids.filter(id => this.entries.has(id));
    if (known.length === 0) return;
    this.record({ kind: 'bind', ids: known, commitId: randomUUID(), commit: { ...commit, files: [...commit.files] } });
  }

  getCommit(entry: JournalEntry): CommitOptions | undefined {
    return entry.commitId === undefined ? undefined : this.commits.get(entry.commitId);
  }

  recordSnapshotBoundary(ids: string[], sha: string, tag: string): void {
    const known = ids.filter(id => this.entries.has(id));
    if (known.length === 0) return;
    this.record({ kind: 'patch', ids: known, patch: { gitBoundarySha: sha, snapshotTag: tag } });
  }

  complete(id: string): void {
    this.completeMany([id]);
  }

  completeMany(ids: string[]): void {
    const known = ids.filter(id => this.entries.has(id));
    if (known.length > 0) this.record({ kind: 'drop', ids: known });
  }

  getPending(): JournalEntry[] {
    return [...this.entries.values()].filter(e => e.status !== 'committed');
  }

  getIndexedPending(): JournalEntry[] {
    return [...this.entries.values()].filter(e => e.status === 'indexed');
  }

  findIndexedByFiles(files: string[]): JournalEntry[] {
    const wanted = new Set(files.map(file => path.resolve(file)));
    return this.getIndexedPending().filter(entry => {
      const evidence = entry.files ?? [entry.filePath];
      return evidence.some(file => wanted.has(path.resolve(file)));
    });
  }

  /**
   * Reconcile incomplete operations on startup.
   * Returns a list of recovery actions taken.
   */
  reconcile(opts: { retainIndexed?: boolean } = {}): string[] {
    const actions: string[] = [];
    const pending = this.getPending();

    for (const entry of pending) {
      if (entry.status === 'pending' && entry.tempPath) {
        // Write never completed — clean up temp file
        if (existsSync(entry.tempPath)) {
          try {
            unlinkSync(entry.tempPath);
            actions.push(`Cleaned up incomplete temp file: ${entry.tempPath}`);
          } catch {
            actions.push(`Failed to clean temp file: ${entry.tempPath}`);
          }
        }
      } else if (entry.status === 'file_written') {
        // File written but not indexed — mark for reindex
        actions.push(`File written but not indexed: ${entry.filePath} (doc: ${entry.docId}). Run reindex to recover.`);
      } else if (entry.status === 'indexed') {
        // Indexed but git commit failed — non-critical, just note it
        actions.push(`Indexed write pending history recovery: ${entry.filePath} (doc: ${entry.docId}).`);
      }
    }

    // Legacy callers clear all entries. Engine startup retains indexed
    // evidence so the history controller can finish the configured boundary.
    if (pending.length > 0) {
      this.completeMany([...this.entries.values()]
        .filter(entry => !opts.retainIndexed || entry.status !== 'indexed')
        .map(entry => entry.id));
    }

    return actions;
  }
}

// Windows scanners can briefly deny access to a just-read file. Keep the old
// journal intact while making a bounded retry.
function retrySharing(operation: () => void, retries: number): void {
  for (let attempt = 0; ; attempt++) {
    try {
      operation();
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= retries || !['EACCES', 'EPERM', 'EBUSY'].includes(code ?? '')) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
    }
  }
}

/**
 * Atomic file write: write to temp path, then rename.
 * On failure, temp file is cleaned up.
 */
export function atomicWriteSync(targetPath: string, content: string, renameRetries = 0): string {
  const tempPath = `${targetPath}.maad-tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tempPath, content, { encoding: 'utf-8', flag: 'wx' });
    retrySharing(() => renameSync(tempPath, targetPath), renameRetries);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
  return targetPath;
}

export async function atomicWrite(targetPath: string, content: string): Promise<string> {
  const { writeFile: fsWriteFile, rename, unlink: fsUnlink } = await import('node:fs/promises');
  const tempPath = `${targetPath}.maad-tmp-${process.pid}-${randomUUID()}`;
  try {
    await fsWriteFile(tempPath, content, { encoding: 'utf-8', flag: 'wx' });
    await rename(tempPath, targetPath);
  } finally {
    try { await fsUnlink(tempPath); } catch { /* renamed or already cleaned */ }
  }
  return targetPath;
}

/** Publish a complete file without ever replacing an existing target. */
type AtomicCreateOps = Pick<typeof import('node:fs/promises'), 'writeFile' | 'link' | 'unlink'>;

export async function atomicCreate(targetPath: string, content: string, injectedOps?: AtomicCreateOps): Promise<string> {
  const { writeFile: fsWriteFile, link, unlink: fsUnlink } = injectedOps ?? await import('node:fs/promises');
  const tempPath = `${targetPath}.maad-tmp-${process.pid}-${randomUUID()}`;
  try {
    await fsWriteFile(tempPath, content, { encoding: 'utf-8', flag: 'wx' });
    try {
      await link(tempPath, targetPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP') throw error;
      // Some filesystems cannot publish via hard link. Preserve exclusive
      // create semantics with wx; the tradeoff is that a concurrent reader
      // may observe the direct write before it completes.
      await fsWriteFile(targetPath, content, { encoding: 'utf-8', flag: 'wx' });
    }
  } finally {
    try { await fsUnlink(tempPath); } catch { /* best-effort cleanup */ }
  }
  return targetPath;
}
