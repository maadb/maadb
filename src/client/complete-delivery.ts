import type { DeliveryPage } from '../mcp/complete-delivery.js';
import { rawSha256 } from '../engine/document-receipt.js';
import { canonicalDeliveryJson } from '../engine/delivery-json.js';
import { expandCompactJson, type CompactJson } from '../engine/compact-json.js';
import type { JsonValue } from '../engine/document-receipt-types.js';

/** Assemble only complete, ordered, unexpired observations. Never accepts a summary. */
export function assembleCompleteDelivery(pages: readonly DeliveryPage[], now = Date.now()): JsonValue {
  if (!Array.isArray(pages)) throw new Error('Invalid delivery pages');
  const first = pages[0];
  if (!first || pages.length > 1024 || first.totalBytes > 1024 * 1024 || first.totalBytes <= 0
    || first.totalCharacters > 1024 * 1024 || first.totalCharacters <= 0) throw new Error('Invalid delivery bounds');
  let offset = 0;
  const chunks: string[] = [];
  for (const [index, page] of pages.entries()) {
    if (![page.totalBytes, page.totalCharacters, page.offset, page.endOffset, page.expiresAt].every(Number.isSafeInteger)
      || typeof page.chunk !== 'string' || !/^[0-9a-f]{64}$/.test(page.digest) || !/^[0-9a-f]{64}$/.test(page.packedDigest)
      || page.delivery !== 'complete-json-v1' || page.encoding !== 'shape-json-v1'
      || page.snapshotId !== first.snapshotId || page.digest !== first.digest || page.packedDigest !== first.packedDigest
      || page.totalBytes !== first.totalBytes || page.totalCharacters !== first.totalCharacters
      || page.expiresAt !== first.expiresAt || page.expiresAt <= now || page.offset !== offset
      || page.endOffset !== page.offset + page.chunk.length || page.endOffset > first.totalCharacters
      || page.endOffset <= page.offset || page.complete !== (page.endOffset === first.totalCharacters)
      || page.complete !== (index === pages.length - 1)
      || page.nextCursor !== (page.complete ? null : `${page.snapshotId}:${page.endOffset}`)) throw new Error('Incomplete or mixed delivery');
    chunks.push(page.chunk);
    offset = page.endOffset;
  }
  const packed = chunks.join('');
  if (offset !== first.totalCharacters || Buffer.byteLength(packed) !== first.totalBytes
    || rawSha256(Buffer.from(packed)) !== first.packedDigest) throw new Error('Delivery integrity mismatch');
  const data = expandCompactJson(JSON.parse(packed) as CompactJson);
  if (rawSha256(Buffer.from(canonicalDeliveryJson(data))) !== first.digest) throw new Error('Complete digest mismatch');
  return data;
}
