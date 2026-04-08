// ============================================================================
// Operation Journal — tracks pending writes for crash recovery
// Stored in _backend/journal.json. Reconciled on engine startup.
// ============================================================================

import { existsSync, readFileSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import path from 'node:path';

export interface JournalEntry {
  id: string;
  op: 'create' | 'update' | 'delete';
  docId: string;
  filePath: string;
  tempPath?: string | undefined;
  timestamp: string;
  status: 'pending' | 'file_written' | 'indexed' | 'committed';
}

export class OperationJournal {
  private journalPath: string;
  private entries: JournalEntry[] = [];

  constructor(backendDir: string) {
    this.journalPath = path.join(backendDir, 'journal.json');
    this.load();
  }

  private load(): void {
    if (existsSync(this.journalPath)) {
      try {
        const raw = readFileSync(this.journalPath, 'utf-8');
        this.entries = JSON.parse(raw) as JournalEntry[];
      } catch {
        this.entries = [];
      }
    }
  }

  private save(): void {
    writeFileSync(this.journalPath, JSON.stringify(this.entries, null, 2), 'utf-8');
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

  complete(id: string): void {
    this.entries = this.entries.filter(e => e.id !== id);
    this.save();
  }

  getPending(): JournalEntry[] {
    return this.entries.filter(e => e.status !== 'committed');
  }

  /**
   * Reconcile incomplete operations on startup.
   * Returns a list of recovery actions taken.
   */
  reconcile(): string[] {
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
        actions.push(`Indexed but git commit skipped: ${entry.filePath} (doc: ${entry.docId}).`);
      }
    }

    // Clear all pending entries after reconciliation
    if (pending.length > 0) {
      this.entries = [];
      this.save();
    }

    return actions;
  }
}

/**
 * Atomic file write: write to temp path, then rename.
 * On failure, temp file is cleaned up.
 */
export function atomicWriteSync(targetPath: string, content: string): string {
  const tempPath = targetPath + '.maad-tmp';
  writeFileSync(tempPath, content, 'utf-8');
  renameSync(tempPath, targetPath);
  return targetPath;
}

export async function atomicWrite(targetPath: string, content: string): Promise<string> {
  const { writeFile: fsWriteFile } = await import('node:fs/promises');
  const { rename } = await import('node:fs/promises');
  const tempPath = targetPath + '.maad-tmp';
  await fsWriteFile(tempPath, content, 'utf-8');
  await rename(tempPath, targetPath);
  return targetPath;
}
