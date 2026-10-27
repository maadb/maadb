// ============================================================================
// Create a file only when nothing exists at its path.
//
// The 'wx' flag makes the existence check and the create one operation, so a
// file that appears between a separate check and the write is never
// overwritten. Returns false when the file already exists.
// ============================================================================

import { writeFileSync } from 'node:fs';

export function writeFileIfAbsent(filePath: string, content: string): boolean {
  try {
    writeFileSync(filePath, content, { encoding: 'utf-8', flag: 'wx' });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
}
