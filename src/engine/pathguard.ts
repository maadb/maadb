// ============================================================================
// Path Guard — canonicalized containment checks
// Prevents path traversal attacks (../, sibling dirs, symlinks)
// ============================================================================

import path from 'node:path';
import { realpathSync } from 'node:fs';

/**
 * Check that a target path is contained within the root directory.
 * Uses path.resolve for canonicalization, not startsWith on raw strings.
 * Handles ../, sibling paths, and trailing separators.
 */
export function isContainedIn(targetPath: string, rootDir: string): boolean {
  const resolvedRoot = path.resolve(rootDir) + path.sep;
  const resolvedTarget = path.resolve(targetPath);
  // Target must either equal root or start with root + separator
  return resolvedTarget === path.resolve(rootDir) || resolvedTarget.startsWith(resolvedRoot);
}

/**
 * Same check but follows symlinks to their real paths.
 * Use when the target path already exists on disk.
 */
export function isReallyContainedIn(targetPath: string, rootDir: string): boolean {
  try {
    const realRoot = realpathSync(rootDir) + path.sep;
    const realTarget = realpathSync(targetPath);
    return realTarget === realpathSync(rootDir) || realTarget.startsWith(realRoot);
  } catch {
    // If realpath fails (file doesn't exist), fall back to resolve check
    return isContainedIn(targetPath, rootDir);
  }
}

/**
 * Assert containment or throw. Use at validation boundaries.
 */
export function assertContainedIn(targetPath: string, rootDir: string, context: string): void {
  if (!isContainedIn(targetPath, rootDir)) {
    throw new Error(`Path escape rejected (${context}): ${targetPath} is outside ${rootDir}`);
  }
}
