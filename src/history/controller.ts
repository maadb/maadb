import type { CommitOptions, CommitOutcome, GitLayer } from '../git/index.js';
import { commitSha, docId, docType } from '../types.js';
import type { JournalEntry, OperationJournal } from '../engine/journal.js';
import type {
  HistoryFlushResult,
  HistoryFlushTrigger,
  HistoryHealthState,
  HistoryRuntime,
  ResolvedHistoryConfig,
} from './types.js';

interface PendingCommit {
  options: CommitOptions;
  journalIds: string[];
}

const CLOSE_TIMEOUT_MS = 5_000;

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function snapshotTagName(now = new Date()): string {
  return `maad-snapshot-${now.toISOString().replace(/[:.]/g, '-').replace('T', '-').replace('Z', '')}`;
}

function recoveredCommit(entries: JournalEntry[]): CommitOptions {
  const first = entries[0]!;
  return {
    action: first.op,
    docId: docId(first.docId),
    docType: docType('unknown'),
    detail: `recovery:${entries.length}`,
    summary: `Recovered ${entries.length} indexed write${entries.length === 1 ? '' : 's'}`,
    files: unique(entries.flatMap(entry => entry.files ?? [entry.filePath])),
  };
}

function combinePending(pending: PendingCommit[]): CommitOptions {
  const first = pending[0]!.options;
  const logicalWrites = unique(pending.flatMap(item => item.journalIds)).length || pending.length;
  return {
    ...first,
    detail: pending.length === 1 ? first.detail : `batch:${logicalWrites}`,
    summary: pending.length === 1 ? first.summary : `Flushed ${logicalWrites} pending writes`,
    files: unique(pending.flatMap(item => item.options.files)),
  };
}

export class HistoryController implements HistoryRuntime {
  readonly config: ResolvedHistoryConfig;

  private readonly gitLayer: GitLayer | null;
  private readonly journal: OperationJournal;
  private pending: PendingCommit[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushTail: Promise<void> = Promise.resolve();
  private lastSuccessfulFlush: string | null = null;
  private lastFlushError: HistoryHealthState['lastFlushError'] = null;
  private closed = false;
  private serialize: <T>(op: string, fn: () => Promise<T>) => Promise<T>;

  constructor(
    config: ResolvedHistoryConfig,
    gitLayer: GitLayer | null,
    journal: OperationJournal,
    serialize: <T>(op: string, fn: () => Promise<T>) => Promise<T> = async (_op, fn) => fn(),
  ) {
    this.config = config;
    this.gitLayer = gitLayer;
    this.journal = journal;
    this.serialize = serialize;
  }

  bindSerializer(serialize: <T>(op: string, fn: () => Promise<T>) => Promise<T>): void {
    this.serialize = serialize;
  }

  async recover(): Promise<HistoryFlushResult | null> {
    const indexed = this.journal.getIndexedPending();
    if (indexed.length === 0) return null;

    if (this.config.effectiveMode === 'feed') {
      this.journal.completeMany(indexed.map(entry => entry.id));
      this.lastSuccessfulFlush = new Date().toISOString();
      return { trigger: 'recovery', pendingWrites: 0, outcome: { status: 'noop' } };
    }
    if (this.config.effectiveMode === 'read') return null;

    this.hydrateJournalPending(indexed);
    return this.serialize('history:recovery', () => this.flush('recovery'));
  }

  async commit(options: CommitOptions): Promise<CommitOutcome> {
    if (this.config.effectiveMode === 'read') {
      return { status: 'failed', code: 'PROJECT_READ_ONLY', message: 'Project history_mode is read' };
    }

    const entries = this.journal.findIndexedByFiles(options.files);
    const journalIds = entries.map(entry => entry.id);
    this.journal.bindCommit(journalIds, options);

    if (this.config.effectiveMode === 'feed') {
      this.journal.completeMany(journalIds);
      this.lastSuccessfulFlush = new Date().toISOString();
      this.lastFlushError = null;
      return { status: 'noop' };
    }

    if (this.config.effectiveMode === 'audit') {
      const outcome = await this.commitGit(options);
      if (outcome.status !== 'failed') {
        this.journal.completeMany(journalIds);
        this.lastSuccessfulFlush = new Date().toISOString();
        this.lastFlushError = null;
      } else {
        this.pending.push({ options, journalIds });
      }
      return outcome;
    }

    this.pending.push({ options, journalIds });
    this.armTimer();
    const threshold = this.config.options.max_writes;
    if (threshold !== undefined && this.pendingWriteCount() >= threshold) {
      return (await this.flush('threshold')).outcome;
    }
    return { status: 'noop' };
  }

  flush(trigger: HistoryFlushTrigger): Promise<HistoryFlushResult> {
    let resolveResult!: (result: HistoryFlushResult) => void;
    const result = new Promise<HistoryFlushResult>(resolve => { resolveResult = resolve; });
    this.flushTail = this.flushTail
      .catch(() => undefined)
      .then(async () => {
        try {
          resolveResult(await this.flushNow(trigger));
        } catch (error) {
          const outcome: CommitOutcome = {
            status: 'failed',
            code: 'HISTORY_FLUSH_FAILED',
            message: error instanceof Error ? error.message : String(error),
          };
          this.noteFailure(trigger, outcome);
          resolveResult({ trigger, pendingWrites: this.pendingWriteCount(), outcome });
        }
      });
    return result;
  }

  health(): HistoryHealthState {
    return {
      effectiveMode: this.config.effectiveMode,
      configuredMode: this.config.configuredMode,
      modeSource: this.config.modeSource,
      pendingWrites: this.pendingWriteCount(),
      lastSuccessfulFlush: this.lastSuccessfulFlush,
      lastFlushError: this.lastFlushError,
      advisories: [...this.config.advisories],
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer();
    if (this.config.effectiveMode === 'feed' || this.config.effectiveMode === 'read') return;

    let timeout: NodeJS.Timeout | null = null;
    await Promise.race([
      this.serialize('history:shutdown', () => this.flush('shutdown')).then(() => undefined),
      new Promise<void>(resolve => {
        timeout = setTimeout(() => {
          this.lastFlushError = {
            at: new Date().toISOString(),
            code: 'HISTORY_FLUSH_TIMEOUT',
            message: `History shutdown flush exceeded ${CLOSE_TIMEOUT_MS}ms`,
            trigger: 'shutdown',
          };
          resolve();
        }, CLOSE_TIMEOUT_MS);
        timeout.unref?.();
      }),
    ]);
    if (timeout) clearTimeout(timeout);
  }

  private async flushNow(trigger: HistoryFlushTrigger): Promise<HistoryFlushResult> {
    this.clearTimer();
    if (this.config.effectiveMode === 'feed' || this.config.effectiveMode === 'read') {
      const indexed = this.journal.getIndexedPending();
      if (this.config.effectiveMode === 'feed') this.journal.completeMany(indexed.map(entry => entry.id));
      this.lastSuccessfulFlush = new Date().toISOString();
      return { trigger, pendingWrites: this.pendingWriteCount(), outcome: { status: 'noop' } };
    }

    this.hydrateJournalPending(this.journal.getIndexedPending());
    if (this.pending.length === 0) {
      this.lastSuccessfulFlush = new Date().toISOString();
      return { trigger, pendingWrites: 0, outcome: { status: 'noop' } };
    }

    const boundaryEntry = this.journal.getIndexedPending()
      .find(entry => entry.gitBoundarySha && entry.snapshotTag);
    if (this.config.effectiveMode === 'snapshot' && boundaryEntry?.gitBoundarySha && boundaryEntry.snapshotTag) {
      const boundaryIds = this.journal.getIndexedPending()
        .filter(entry => entry.gitBoundarySha === boundaryEntry.gitBoundarySha && entry.snapshotTag === boundaryEntry.snapshotTag)
        .map(entry => entry.id);
      const boundaryIdSet = new Set(boundaryIds);
      const outcome: CommitOutcome = { status: 'committed', sha: commitSha(boundaryEntry.gitBoundarySha) };
      try {
        await this.ensureSnapshotTag(boundaryEntry.snapshotTag, boundaryEntry.gitBoundarySha);
      } catch (error) {
        const failed: CommitOutcome = {
          status: 'failed',
          code: 'GIT_TAG_FAILED',
          message: `snapshot tag failed: ${error instanceof Error ? error.message : String(error)}`,
        };
        this.noteFailure(trigger, failed);
        this.armTimer();
        return { trigger, pendingWrites: this.pendingWriteCount(), outcome: failed };
      }
      this.journal.completeMany(boundaryIds);
      this.pending = this.pending.flatMap(item => {
        const remaining = item.journalIds.filter(id => !boundaryIdSet.has(id));
        return remaining.length === 0 ? [] : [{ ...item, journalIds: remaining }];
      });
      this.lastSuccessfulFlush = new Date().toISOString();
      this.lastFlushError = null;
      if (this.pending.length > 0) return this.flushNow(trigger);
      return { trigger, pendingWrites: this.pendingWriteCount(), outcome };
    }

    const flushing = this.pending;
    this.pending = [];
    const journalIds = unique(flushing.flatMap(item => item.journalIds));
    let outcome: CommitOutcome;

    outcome = await this.commitGit(combinePending(flushing));

    if (outcome.status === 'failed') {
      this.pending.unshift(...flushing);
      this.noteFailure(trigger, outcome);
      this.armTimer();
      return { trigger, pendingWrites: this.pendingWriteCount(), outcome };
    }

    if (this.config.effectiveMode === 'snapshot' && outcome.status === 'committed') {
      const tag = snapshotTagName();
      this.journal.recordSnapshotBoundary(journalIds, outcome.sha as string, tag);
      try {
        await this.ensureSnapshotTag(tag, outcome.sha as string);
      } catch (error) {
        const failed: CommitOutcome = {
          status: 'failed',
          code: 'GIT_TAG_FAILED',
          message: `snapshot tag failed: ${error instanceof Error ? error.message : String(error)}`,
        };
        this.pending.unshift(...flushing);
        this.noteFailure(trigger, failed);
        this.armTimer();
        return { trigger, pendingWrites: this.pendingWriteCount(), outcome: failed };
      }
    }

    this.journal.completeMany(journalIds);
    this.lastSuccessfulFlush = new Date().toISOString();
    this.lastFlushError = null;
    if (this.pending.length > 0) this.armTimer();
    return { trigger, pendingWrites: this.pendingWriteCount(), outcome };
  }

  private async commitGit(options: CommitOptions): Promise<CommitOutcome> {
    if (!this.gitLayer) {
      return {
        status: 'failed',
        code: 'GIT_NOT_INITIALIZED',
        message: `history_mode ${this.config.effectiveMode} requires Git`,
      };
    }
    return this.gitLayer.commit(options);
  }

  private async ensureSnapshotTag(tag: string, sha: string): Promise<void> {
    const existing = await this.gitLayer!.listTagsByPrefix(tag);
    const exact = existing.find(candidate => candidate.tag === tag);
    if (exact) {
      if (exact.sha === sha) return;
      throw new Error(`snapshot tag ${tag} already points at ${exact.sha || 'a non-commit object'}`);
    }
    try {
      await this.gitLayer!.addAnnotatedTag(tag, `MAADB history snapshot at ${sha}`, sha);
    } catch (error) {
      const after = await this.gitLayer!.listTagsByPrefix(tag);
      if (after.some(candidate => candidate.tag === tag && candidate.sha === sha)) return;
      throw error;
    }
  }

  private hydrateJournalPending(entries: JournalEntry[]): void {
    const queuedIds = new Set(this.pending.flatMap(item => item.journalIds));
    const missing = entries.filter(entry => !queuedIds.has(entry.id));
    if (missing.length === 0) return;

    const groups = new Map<string, JournalEntry[]>();
    for (const entry of missing) {
      const key = entry.commit ? JSON.stringify(entry.commit) : '__recovery__';
      const group = groups.get(key) ?? [];
      group.push(entry);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      this.pending.push({
        options: group[0]?.commit ?? recoveredCommit(group),
        journalIds: group.map(entry => entry.id),
      });
    }
  }

  private pendingWriteCount(): number {
    const journalCount = this.journal.getIndexedPending().length;
    const unjournaled = this.pending.filter(item => item.journalIds.length === 0).length;
    return journalCount + unjournaled;
  }

  private noteFailure(trigger: HistoryFlushTrigger, outcome: Extract<CommitOutcome, { status: 'failed' }>): void {
    this.lastFlushError = {
      at: new Date().toISOString(),
      code: outcome.code,
      message: outcome.message,
      trigger,
    };
  }

  private armTimer(): void {
    if (this.closed || this.timer || this.pendingWriteCount() === 0) return;
    const delay = this.config.options.max_delay_ms;
    if (delay === undefined) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.serialize('history:timer', () => this.flush('timer'));
    }, delay);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
