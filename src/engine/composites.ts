// ============================================================================
// Composites — Tier 2 deterministic bundled reads (provisional)
// Evaluate after MCP: keep only if they measurably reduce tool chatter.
// ============================================================================

import { ok, singleErr, type Result } from '../errors.js';
import {
  docId as toDocId,
  type DocId,
} from '../types.js';
import { logger } from './logger.js';
import type { EngineContext } from './context.js';
import type { GetFullResult } from './types.js';
import { readFrontmatter } from './helpers.js';

export async function getDocumentFull(ctx: EngineContext, id: DocId): Promise<Result<GetFullResult>> {
  const doc = ctx.backend.getDocument(id);
  if (!doc) return singleErr('FILE_NOT_FOUND', `Document "${id as string}" not found`);

  const frontmatter = await readFrontmatter(ctx.projectRoot, doc);

  // Resolve ref fields to names
  const schema = ctx.schemaStore.getSchemaForType(doc.docType);
  const resolvedRefs: Record<string, { docId: string; name: string }> = {};
  if (schema) {
    for (const [fieldName, fieldDef] of schema.fields) {
      if (fieldDef.type === 'ref' && frontmatter[fieldName]) {
        const targetId = String(frontmatter[fieldName]);
        const targetDoc = ctx.backend.getDocument(toDocId(targetId));
        if (targetDoc) {
          const targetFm = await readFrontmatter(ctx.projectRoot, targetDoc);
          resolvedRefs[fieldName] = {
            docId: targetId,
            name: String(targetFm['name'] ?? targetFm['title'] ?? targetId),
          };
        }
      }
    }
  }

  const objects = ctx.backend.findObjects({ docId: id, limit: 50 });

  const rels = ctx.backend.getRelationships(id, 'both');

  // Batch lookup all related doc IDs
  const relatedIds = new Set<import('../types.js').DocId>();
  for (const rel of rels) {
    if (rel.sourceDocId === id) relatedIds.add(rel.targetDocId);
    else relatedIds.add(rel.sourceDocId);
  }
  const docsMap = ctx.backend.getDocumentsByIds([...relatedIds]);

  const outgoing: GetFullResult['related']['outgoing'] = [];
  const incoming: GetFullResult['related']['incoming'] = [];

  for (const rel of rels) {
    if (rel.sourceDocId === id) {
      const target = docsMap.get(rel.targetDocId);
      outgoing.push({
        docId: rel.targetDocId as string,
        docType: (target?.docType ?? 'unknown') as string,
        field: rel.field,
      });
    } else {
      const source = docsMap.get(rel.sourceDocId);
      incoming.push({
        docId: rel.sourceDocId as string,
        docType: (source?.docType ?? 'unknown') as string,
        field: rel.field,
      });
    }
  }

  // Latest incoming note. The index already orders notes by updatedAt, so
  // read git history newest first and stop once the next note was last
  // written before the best commit found: it cannot hold a newer one. In the
  // usual case that is one git call, not one per note. A note whose newest
  // update has no engine commit yet (edited outside the engine, or waiting
  // for a batched flush) does not hide a newer commit on an older note.
  let latestNote: GetFullResult['latestNote'] = null;
  if (ctx.gitLayer) {
    const notes = new Map<string, NonNullable<ReturnType<typeof docsMap.get>>>();
    for (const inc of incoming) {
      if (!inc.docType.includes('note') || notes.has(inc.docId)) continue;
      const incDoc = docsMap.get(toDocId(inc.docId));
      if (incDoc) notes.set(inc.docId, incDoc);
    }
    const newestFirst = [...notes.entries()].sort(([, a], [, b]) =>
      a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0);
    let bestMs = -Infinity;
    for (const [noteId, noteDoc] of newestFirst) {
      // Git timestamps have one-second resolution; allow for it.
      if (Date.parse(noteDoc.updatedAt) < bestMs - 1000) break;
      try {
        const [entry] = await ctx.gitLayer.history(noteDoc.filePath as string, { limit: 1 });
        if (entry && Date.parse(entry.timestamp) > bestMs) {
          bestMs = Date.parse(entry.timestamp);
          latestNote = { docId: noteId, summary: entry.summary, timestamp: entry.timestamp };
        }
      } catch (e) {
        logger.bestEffort('composites', 'getDocumentFull.latestNote', `Git history lookup failed for ${noteId}`, { error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  return ok({
    docId: doc.docId,
    docType: doc.docType,
    version: doc.version,
    updatedAt: doc.updatedAt,
    frontmatter,
    resolvedRefs,
    objects,
    related: { outgoing, incoming },
    latestNote,
  });
}
