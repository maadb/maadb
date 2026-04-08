// ============================================================================
// Write tools — maad.create, maad.update, maad.validate
// ============================================================================

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MaadEngine } from '../../engine.js';
import { docId, docType } from '../../types.js';
import { resultToResponse } from '../response.js';
import { isDryRun, dryRunResponse, auditToolCall } from '../guardrails.js';

export function register(server: McpServer, engine: MaadEngine): void {
  server.registerTool('maad.create', {
    description: 'Creates a new markdown record. Schema-validated. Auto-commits to git. Returns the new docId, filePath, and version.',
    inputSchema: z.object({
      docType: z.string().describe('Document type to create'),
      fields: z.any().describe('Frontmatter fields (name, status, etc.)'),
      body: z.string().optional().describe('Markdown body content'),
      docId: z.string().optional().describe('Custom doc_id (auto-generated if omitted)'),
    }),
  }, async (args) => {
    auditToolCall('maad.create', args);
    if (isDryRun()) return dryRunResponse('maad.create', args);
    const result = await engine.createDocument(
      docType(args.docType),
      args.fields as Record<string, unknown>,
      args.body ?? undefined,
      args.docId ?? undefined,
    );
    return resultToResponse(result);
  });

  server.registerTool('maad.update', {
    description: 'Updates a record\'s fields or body. Pass expectedVersion from a prior get to detect concurrent modifications.',
    inputSchema: z.object({
      docId: z.string().describe('Document ID to update'),
      fields: z.any().optional().describe('Frontmatter fields to update'),
      body: z.string().optional().describe('Replace entire body'),
      appendBody: z.string().optional().describe('Append to existing body'),
      expectedVersion: z.number().optional().describe('Version from prior get — rejects if document has changed'),
    }),
  }, async (args) => {
    auditToolCall('maad.update', args);
    if (isDryRun()) return dryRunResponse('maad.update', args);
    const result = await engine.updateDocument(
      docId(args.docId),
      args.fields as Record<string, unknown> | undefined ?? undefined,
      args.body ?? undefined,
      args.appendBody ?? undefined,
      args.expectedVersion ?? undefined,
    );
    return resultToResponse(result);
  });

  server.registerTool('maad.validate', {
    description: 'Validates one or all documents against their schemas. Returns validation report with any errors.',
    inputSchema: z.object({
      docId: z.string().optional().describe('Validate a specific document (all if omitted)'),
    }),
  }, async (args) => {
    const result = await engine.validate(args.docId ? docId(args.docId) : undefined);
    return resultToResponse(result);
  });

  server.registerTool('maad.bulk_create', {
    description: 'Creates multiple records in one call. Validates each record, writes files, single git commit. Returns per-record success/failure. Much faster than individual creates for imports.',
    inputSchema: z.object({
      records: z.array(z.object({
        docType: z.string().describe('Document type'),
        fields: z.any().describe('Frontmatter fields'),
        body: z.string().optional().describe('Markdown body'),
        docId: z.string().optional().describe('Custom ID (auto-generated if omitted)'),
      })).describe('Array of records to create'),
    }),
  }, async (args) => {
    auditToolCall('maad.bulk_create', { count: args.records.length });
    if (isDryRun()) return dryRunResponse('maad.bulk_create', { count: args.records.length });
    const result = await engine.bulkCreate(args.records as any);
    return resultToResponse(result);
  });

  server.registerTool('maad.bulk_update', {
    description: 'Updates multiple records in one call. Returns per-record success/failure.',
    inputSchema: z.object({
      updates: z.array(z.object({
        docId: z.string().describe('Document ID to update'),
        fields: z.any().optional().describe('Frontmatter fields to update'),
        body: z.string().optional().describe('Replace entire body'),
        appendBody: z.string().optional().describe('Append to body'),
      })).describe('Array of updates'),
    }),
  }, async (args) => {
    auditToolCall('maad.bulk_update', { count: args.updates.length });
    if (isDryRun()) return dryRunResponse('maad.bulk_update', { count: args.updates.length });
    const result = await engine.bulkUpdate(args.updates as any);
    return resultToResponse(result);
  });
}
