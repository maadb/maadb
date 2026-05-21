// ============================================================================
// 0.7.10 — maad_backup: named recovery anchors via annotated git tags.
//
// Three operations:
//   createBackup — annotated tag on HEAD with structured name. Stamps
//                  `last_backup_tag` into engine_meta so maad_health can
//                  surface the most-recent snapshot without re-scanning.
//   listBackups  — every maad-snapshot-* tag with sha + message + createdAt.
//   deleteBackup — drop a maad-snapshot-* tag (refuses other tags). Does
//                  NOT update last_backup_tag — the surface tracks the most
//                  recent create, not the most recent op.
// ============================================================================

import { ok, singleErr, type Result } from '../errors.js';
import type { EngineContext } from './context.js';
import type { BackupTag, CreateBackupOptions, ListBackupsOptions } from './types.js';

const MAAD_SNAPSHOT_PREFIX = 'maad-snapshot-';
const LABEL_MAX_LEN = 32;

/**
 * Sanitize an operator-supplied label: trim, lowercase, replace runs of
 * non-[a-z0-9-] chars with a single -, strip leading/trailing hyphens,
 * cap at LABEL_MAX_LEN. Returns null when the result is empty.
 */
function sanitizeLabel(raw: string): string | null {
  const sanitized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, LABEL_MAX_LEN)
    .replace(/^-+|-+$/g, '');
  return sanitized.length > 0 ? sanitized : null;
}

function formatTagName(now: Date, label: string | null): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mn = String(now.getUTCMinutes()).padStart(2, '0');
  const base = `${MAAD_SNAPSHOT_PREFIX}${yyyy}-${mm}-${dd}-${hh}${mn}`;
  return label ? `${base}-${label}` : base;
}

export async function createBackup(
  ctx: EngineContext,
  opts: CreateBackupOptions = {},
): Promise<Result<BackupTag>> {
  if (!ctx.gitLayer) {
    return singleErr('GIT_NOT_INITIALIZED', 'Project has no git repository');
  }

  const head = await ctx.gitLayer.headSha();
  if (!head) {
    return singleErr('NO_HEAD_COMMIT', 'Repository has no commits yet — nothing to snapshot');
  }

  let label: string | null = null;
  if (opts.label !== undefined && opts.label !== '') {
    label = sanitizeLabel(opts.label);
    if (label === null) {
      return singleErr(
        'INVALID_FIELDS',
        `Label "${opts.label}" sanitizes to an empty string — use [a-z0-9-] chars`,
      );
    }
  }

  const tagName = formatTagName(new Date(), label);

  // Collision check — refuse to overwrite an existing tag of the same name.
  const existing = await ctx.gitLayer.listTagsByPrefix(tagName);
  if (existing.some(t => t.tag === tagName)) {
    return singleErr('TAG_EXISTS', `Snapshot "${tagName}" already exists`);
  }

  const branch = await ctx.gitLayer.currentBranch();
  const message = opts.message ?? `MAADB snapshot at ${head} ('${branch}')`;

  await ctx.gitLayer.addAnnotatedTag(tagName, message);

  const createdAt = new Date().toISOString();
  // 0.7.10 — stamp into engine_meta so maad_health.lastBackupTag surfaces
  // without re-scanning git tags. Best-effort — observability fields stay
  // advisory.
  try {
    ctx.backend.setMeta('last_backup_tag', JSON.stringify({
      tag: tagName,
      sha: head,
      createdAt,
    }));
  } catch {
    // best-effort
  }

  return ok({
    tag: tagName,
    sha: head,
    message,
    createdAt,
  });
}

export async function listBackups(
  ctx: EngineContext,
  opts: ListBackupsOptions = {},
): Promise<Result<BackupTag[]>> {
  if (!ctx.gitLayer) return ok([]);

  const all = await ctx.gitLayer.listTagsByPrefix(MAAD_SNAPSHOT_PREFIX);

  if (opts.since !== undefined) {
    const sinceMs = Date.parse(opts.since);
    if (Number.isNaN(sinceMs)) {
      return singleErr('INVALID_FIELDS', `since is not a valid ISO8601 date: "${opts.since}"`);
    }
    return ok(all.filter(t => {
      const tagMs = Date.parse(t.createdAt);
      return !Number.isNaN(tagMs) && tagMs >= sinceMs;
    }));
  }

  return ok(all);
}

export async function deleteBackup(
  ctx: EngineContext,
  tag: string,
): Promise<Result<{ removed: string }>> {
  if (!ctx.gitLayer) {
    return singleErr('GIT_NOT_INITIALIZED', 'Project has no git repository');
  }
  if (!tag.startsWith(MAAD_SNAPSHOT_PREFIX)) {
    return singleErr(
      'INVALID_FIELDS',
      `maad_backup delete only removes ${MAAD_SNAPSHOT_PREFIX}* tags — got "${tag}"`,
    );
  }

  const existing = await ctx.gitLayer.listTagsByPrefix(tag);
  if (!existing.some(t => t.tag === tag)) {
    return singleErr('TAG_NOT_FOUND', `Tag "${tag}" does not exist`);
  }

  await ctx.gitLayer.deleteTag(tag);
  return ok({ removed: tag });
}
