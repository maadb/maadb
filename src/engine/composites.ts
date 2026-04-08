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
  const outgoing: GetFullResult['related']['outgoing'] = [];
  const incoming: GetFullResult['related']['incoming'] = [];

  for (const rel of rels) {
    if (rel.sourceDocId === id) {
      const target = ctx.backend.getDocument(rel.targetDocId);
      outgoing.push({
        docId: rel.targetDocId as string,
        docType: (target?.docType ?? 'unknown') as string,
        field: rel.field,
      });
    } else {
      const source = ctx.backend.getDocument(rel.sourceDocId);
      incoming.push({
        docId: rel.sourceDocId as string,
        docType: (source?.docType ?? 'unknown') as string,
        field: rel.field,
      });
    }
  }

  // Latest incoming note
  let latestNote: GetFullResult['latestNote'] = null;
  if (ctx.gitLayer) {
    for (const inc of incoming) {
      const incDoc = ctx.backend.getDocument(toDocId(inc.docId));
      if (!incDoc) continue;
      if (!(inc.docType.includes('note'))) continue;

      try {
        const history = await ctx.gitLayer.history(incDoc.filePath as string, { limit: 1 });
        if (history.length > 0) {
          const entry = history[0]!;
          if (!latestNote || entry.timestamp > latestNote.timestamp) {
            latestNote = {
              docId: inc.docId,
              summary: entry.summary,
              timestamp: entry.timestamp,
            };
          }
        }
      } catch (e) {
        logger.bestEffort('composites', 'getDocumentFull.latestNote', `Git history lookup failed for ${inc.docId}`, { error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  return ok({
    docId: doc.docId,
    docType: doc.docType,
    frontmatter,
    resolvedRefs,
    objects,
    related: { outgoing, incoming },
    latestNote,
  });
}
