// ============================================================================
// Operation Journal — tracks pending writes for crash recovery
// Stored in _backend/journal.json. Reconciled on engine startup.
// ============================================================================

import { existsSync, readFileSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
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
const JOURNAL_VERSION = 2;

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

export class OperationJournal {
  private journalPath: string;
  private entries: JournalEntry[] = [];
  private commits = new Map<string, CommitOptions>();
  private persisted = '[]';

  constructor(backendDir: string) {
    this.journalPath = path.join(backendDir, 'journal.json');
    this.load();
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.journalPath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch {
      throw new Error('Invalid operation journal JSON; preserve journal.json and repair it before restarting');
    }
    this.restore(parsed);
    this.persisted = raw;
  }

  private restore(parsed: unknown): void {
    const invalid = new Error('Invalid operation journal entries; preserve journal.json and repair it before restarting');
    let stored: unknown;
    const commits = new Map<string, CommitOptions>();
    if (Array.isArray(parsed)) {
      stored = parsed;
    } else {
      const file = parsed as { version?: unknown; commits?: unknown; entries?: unknown } | null;
      if (file?.version !== JOURNAL_VERSION || !file.commits || typeof file.commits !== 'object') throw invalid;
      for (const [id, commit] of Object.entries(file.commits)) {
        if (!isCommitOptions(commit)) throw invalid;
        commits.set(id, commit);
      }
      stored = file.entries;
    }
    if (!Array.isArray(stored) || !stored.every(isJournalEntry)) throw invalid;

    const interned = new Map<string, string>();
    const entries = stored.map(({ commit, ...entry }) => {
      if (commit) {
        const key = JSON.stringify(commit);
        let commitId = interned.get(key);
        if (commitId === undefined) {
          commitId = randomUUID();
          interned.set(key, commitId);
          commits.set(commitId, commit);
        }
        return { ...entry, commitId };
      }
      if (entry.commitId !== undefined && !commits.has(entry.commitId)) throw invalid;
      return entry;
    });
    this.entries = entries;
    this.commits = commits;
  }

  private serialize(): string {
    const live = new Map<string, CommitOptions>();
    for (const { commitId } of this.entries) {
      if (commitId !== undefined) live.set(commitId, this.commits.get(commitId)!);
    }
    this.commits = live;
    return JSON.stringify({ version: JOURNAL_VERSION, commits: Object.fromEntries(live), entries: this.entries }, null, 2);
  }

  private save(): void {
    const next = this.serialize();
    try {
      atomicWriteSync(this.journalPath, next, process.platform === 'win32' ? 5 : 0);
      this.persisted = next;
    } catch (error) {
      // A failed publication must not leave unpersisted recovery state queued
      // in memory for a later operation or shutdown flush.
      this.restore(JSON.parse(this.persisted));
      throw error;
    }
  }

  begin(op: JournalEntry['op'], docId: string, filePath: string, tempPath?: string): string {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.entries.push({
      id,
      op,
      docId,
      filePath,
      tempPath,
      timestamp: new Date().toISOString(),
      status: 'pending',
    });
    this.save();
    return id;
  }

  advance(id: string, status: JournalEntry['status']): void {
    const entry = this.entries.find(e => e.id === id);
    if (entry) {
      entry.status = status;
      this.save();
    }
  }

  setFiles(id: string, files: string[]): void {
    const entry = this.entries.find(e => e.id === id);
    if (!entry) return;
    entry.files = [...new Set(files)];
    this.save();
  }

  bindCommit(ids: string[], commit: CommitOptions): void {
    if (ids.length === 0) return;
    const wanted = new Set(ids);
    const commitId = randomUUID();
    let changed = false;
    for (const entry of this.entries) {
      if (!wanted.has(entry.id)) continue;
      entry.commitId = commitId;
      changed = true;
    }
    if (!changed) return;
    this.commits.set(commitId, { ...commit, files: [...commit.files] });
    this.save();
  }

  getCommit(entry: JournalEntry): CommitOptions | undefined {
    return entry.commitId === undefined ? undefined : this.commits.get(entry.commitId);
  }

  recordSnapshotBoundary(ids: string[], sha: string, tag: string): void {
    if (ids.length === 0) return;
    const wanted = new Set(ids);
    let changed = false;
    for (const entry of this.entries) {
      if (!wanted.has(entry.id)) continue;
      entry.gitBoundarySha = sha;
      entry.snapshotTag = tag;
      changed = true;
    }
    if (changed) this.save();
  }

  complete(id: string): void {
    this.entries = this.entries.filter(e => e.id !== id);
    this.save();
  }

  completeMany(ids: string[]): void {
    if (ids.length === 0) return;
    const completed = new Set(ids);
    const next = this.entries.filter(e => !completed.has(e.id));
    if (next.length === this.entries.length) return;
    this.entries = next;
    this.save();
  }

  getPending(): JournalEntry[] {
    return this.entries.filter(e => e.status !== 'committed');
  }

  getIndexedPending(): JournalEntry[] {
    return this.entries.filter(e => e.status === 'indexed');
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
      this.entries = opts.retainIndexed
        ? this.entries.filter(entry => entry.status === 'indexed')
        : [];
      this.save();
    }

    return actions;
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
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tempPath, targetPath);
        break;
      } catch (error) {
        // Windows scanners can briefly deny replacement of a just-read file.
        // Keep the old journal intact while making a bounded retry.
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= renameRetries || !['EACCES', 'EPERM', 'EBUSY'].includes(code ?? '')) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
      }
    }
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
