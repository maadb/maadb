import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { MaadEngine } from '../engine.js';
import { canonicalJson, rawSha256 } from '../engine/document-receipt.js';
import { canonicalDeliveryJson, DELIVERY_JSON_LIMITS } from '../engine/delivery-json.js';
import { ReceiptError } from '../git/exact-blob.js';
import { compactJson } from '../engine/compact-json.js';
import { attachMeta, contractResponseMaxBytes, errorResponse, responseBytes, successResponse } from './response.js';

export const deliveryInput = z.object({
  format: z.literal('compact-json-v1'),
  maxBytes: z.number().int().min(8192).max(1024 * 1024).optional(),
  cursor: z.string().max(128).optional(),
}).strict();
export type DeliveryInput = z.infer<typeof deliveryInput>;

export interface DeliveryPage {
  delivery: 'complete-json-v1';
  encoding: 'shape-json-v1';
  snapshotId: string;
  /** Digest of canonical, expanded complete data, not a summary. */
  digest: string;
  packedDigest: string;
  totalBytes: number;
  totalCharacters: number;
  offset: number;
  endOffset: number;
  expiresAt: number;
  complete: boolean;
  nextCursor: string | null;
  chunk: string;
}

type Snapshot = {
  id: string; engine: MaadEngine; session: string; request: string; tool: string;
  text: string; digest: string; packedDigest: string; bytes: number; expires: number; cap: number;
  observation: string; epoch: object;
};
// Process-wide bounds, with at most two snapshots for any engine/session pair.
// No disk storage, timers, background work, or caller-controlled cache keys.
const snapshots = new Map<string, Snapshot>();
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const TTL_MS = 5 * 60 * 1000;
function prune(now: number): void {
  for (const [id, value] of snapshots) if (value.expires <= now || !value.engine.isReceiptReady() || value.epoch !== value.engine.getReceiptEpoch()) snapshots.delete(id);
}

const failure = (message: string, tool: string) => errorResponse([{
  code: 'RECEIPT_OBSERVATION_CHANGED', message,
  details: { tool, hint: 'Discard all pages and restart this read without a cursor. Never replay a write.' },
}]);

/** Called only inside the normal live authorization/readiness wrapper, after a fresh read. */
export function deliverComplete(data: unknown, delivery: DeliveryInput,
  context: { engine: MaadEngine; sessionId: string; tool: string; request: unknown; requestId: string }) {
  try {
    return deliverCompleteChecked(data, delivery, context);
  } catch (error) {
    if (!(error instanceof ReceiptError)) throw error;
    return errorResponse([{
      code: error.code, message: error.message,
      details: { tool: context.tool, capNodes: DELIVERY_JSON_LIMITS.nodes, maxDepth: DELIVERY_JSON_LIMITS.depth,
        capScalarBytes: DELIVERY_JSON_LIMITS.scalarBytes,
        hint: 'Complete data exceeds delivery bounds. Keep verification or write recovery pending; never replay a write.' },
    }]);
  }
}

function deliverCompleteChecked(data: unknown, delivery: DeliveryInput,
  context: { engine: MaadEngine; sessionId: string; tool: string; request: unknown; requestId: string }) {
  const now = Date.now();
  prune(now);
  const request = canonicalJson(context.request);
  // A receipt's time describes its retained observation. Compare every other
  // field on continuation, including immutable evidence and working-tree state.
  const object = data as Record<string, unknown>;
  const observation = rawSha256(Buffer.from(canonicalDeliveryJson(object.contract === 'document-persistence-v1' ? { ...object, observedAt: null } : data)));
  let snapshot: Snapshot;
  let offset = 0;
  if (delivery.cursor !== undefined) {
    const match = /^([0-9a-f-]{36}):(\d{1,7})$/.exec(delivery.cursor);
    const found = match ? snapshots.get(match[1]!) : undefined;
    if (!found || found.engine !== context.engine || found.session !== context.sessionId
      || found.request !== request || found.tool !== context.tool) return failure('Delivery cursor is unavailable or does not match this read', context.tool);
    if (found.observation !== observation) {
      snapshots.delete(found.id);
      return failure('Complete observation changed during delivery', context.tool);
    }
    if (delivery.maxBytes !== undefined && Math.min(delivery.maxBytes, contractResponseMaxBytes()) !== found.cap) return failure('Page budget changed during delivery', context.tool);
    snapshot = found;
    offset = Number(match![2]);
    if (offset <= 0 || offset >= snapshot.text.length) return failure('Invalid delivery offset', context.tool);
  } else {
    const text = JSON.stringify(compactJson(data));
    const bytes = Buffer.byteLength(text);
    if (bytes > MAX_SNAPSHOT_BYTES) return errorResponse([{
      code: 'RESPONSE_TOO_LARGE', message: 'Complete delivery snapshot exceeds hard bound',
      details: { tool: context.tool, observedBytes: bytes, capBytes: MAX_SNAPSHOT_BYTES,
        hint: 'Snapshot cannot be paged within the hard bound. Keep write recovery pending; do not replay.' },
    }]);
    snapshot = { id: randomUUID(), engine: context.engine, session: context.sessionId, tool: context.tool, request,
      text, bytes, digest: rawSha256(Buffer.from(canonicalDeliveryJson(data))), packedDigest: rawSha256(Buffer.from(text)),
      observation, epoch: context.engine.getReceiptEpoch(), expires: now + TTL_MS, cap: Math.min(delivery.maxBytes ?? contractResponseMaxBytes(), contractResponseMaxBytes()) };
  }
  const page = (end: number): DeliveryPage => ({
    delivery: 'complete-json-v1', encoding: 'shape-json-v1', snapshotId: snapshot.id,
    digest: snapshot.digest, packedDigest: snapshot.packedDigest, totalBytes: snapshot.bytes,
    totalCharacters: snapshot.text.length, offset, endOffset: end, expiresAt: snapshot.expires,
    complete: end === snapshot.text.length, nextCursor: end === snapshot.text.length ? null : `${snapshot.id}:${end}`,
    chunk: snapshot.text.slice(offset, end),
  });
  const response = (end: number) => successResponse(page(end), context.tool);
  const measured = (end: number) => responseBytes(process.env.MAAD_EMIT_REQUEST_ID === 'true'
    ? attachMeta(response(end), { request_id: context.requestId }) : response(end));
  const cap = Math.min(snapshot.cap, contractResponseMaxBytes());
  let low = offset, high = snapshot.text.length;
  if (measured(high) <= cap) low = high;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measured(middle) <= cap) low = middle; else high = middle - 1;
  }
  if (low === offset) return errorResponse([{
    code: 'RESPONSE_TOO_LARGE', message: 'Delivery metadata exceeds page budget',
    details: { tool: context.tool, observedBytes: measured(offset + 1), capBytes: cap, hint: 'Increase this delivery budget; restart the read.' },
  }]);
  if (!delivery.cursor && low < snapshot.text.length) {
    const owned = [...snapshots.values()].filter(s => s.engine === context.engine && s.session === context.sessionId);
    while (owned.length >= 2) snapshots.delete(owned.shift()!.id);
    // Bound serialized UTF-8 retention; UTF-16 storage is at most twice this.
    const size = (s: Snapshot) => s.bytes + Buffer.byteLength(s.observation);
    while (snapshots.size >= 16 || [...snapshots.values()].reduce((n, s) => n + size(s), 0) + size(snapshot) > MAX_BYTES) {
      const first = snapshots.keys().next().value;
      if (!first) break;
      snapshots.delete(first);
    }
    snapshots.set(snapshot.id, snapshot);
  }
  return response(low);
}
