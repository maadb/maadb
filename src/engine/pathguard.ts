// ============================================================================
// Path Guard — canonicalized containment checks
// Prevents path traversal attacks (../, sibling dirs, symlinks)
// ============================================================================

import path from 'node:path';
import { existsSync, realpathSync } from 'node:fs';

const SAFE_SCHEMA_REF = /^[a-z][a-z0-9_]*\.v[1-9][0-9]*$/;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

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
    const root = realpathSync(rootDir);
    const realRoot = root + path.sep;
    const realTarget = realpathSync(targetPath);
    return realTarget === root || realTarget.startsWith(realRoot);
  } catch {
    return false;
  }
}

/**
 * Check a path that may not exist yet without losing symlink protection.
 * The nearest existing ancestor is resolved through the filesystem, then the
 * missing suffix is reconstructed beneath that real path.
 */
export function isWritePathContainedIn(targetPath: string, rootDir: string): boolean {
  if (!isContainedIn(targetPath, rootDir)) return false;

  try {
    const realRoot = realpathSync(rootDir);
    let ancestor = path.resolve(targetPath);
    while (!existsSync(ancestor)) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return false;
      ancestor = parent;
    }

    const realAncestor = realpathSync(ancestor);
    if (!isContainedIn(realAncestor, realRoot)) return false;
    const suffix = path.relative(ancestor, path.resolve(targetPath));
    return isContainedIn(path.resolve(realAncestor, suffix), realRoot);
  } catch {
    return false;
  }
}

export function isSafeSchemaRef(value: string): boolean {
  return SAFE_SCHEMA_REF.test(value);
}

export function isSafeProjectRelativePath(value: string): boolean {
  if (value.length === 0 || value.includes('\\') || value.includes('\0') || path.isAbsolute(value)) return false;
  const trimmed = value.endsWith('/') ? value.slice(0, -1) : value;
  if (trimmed.length === 0) return false;
  return trimmed.split('/').every(segment =>
    segment !== '.' && segment !== '..' && SAFE_PATH_SEGMENT.test(segment));
}

/**
 * Assert containment or throw. Use at validation boundaries.
 */
export function assertContainedIn(targetPath: string, rootDir: string, context: string): void {
  if (!isContainedIn(targetPath, rootDir)) {
    throw new Error(`Path escape rejected (${context}): ${targetPath} is outside ${rootDir}`);
  }
}
