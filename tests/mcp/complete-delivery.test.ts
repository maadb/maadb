import { afterEach, describe, expect, it, vi } from 'vitest';
import { MaadEngine, assembleCompleteDelivery } from '../../src/engine.js';
import { compactJson, expandCompactJson } from '../../src/engine/compact-json.js';
import { canonicalJson, parseReceiptContent } from '../../src/engine/document-receipt.js';
import { deliverComplete, type DeliveryPage } from '../../src/mcp/complete-delivery.js';
import { attachMeta, contractResponseMaxBytes, guardResponseSize, responseBytes, responseMaxBytes, setProvenanceMode, successResponse } from '../../src/mcp/response.js';

const context = () => {
  const engine = new MaadEngine();
  vi.spyOn(engine, 'isReceiptReady').mockReturnValue(true);
  return { engine, sessionId: 'example', tool: 'maad_create_contract', request: { docType: 'note' }, requestId: '0'.repeat(36) };
};
const parse = (result: ReturnType<typeof deliverComplete>) => JSON.parse(result.content[0]!.text);
const data = { contract: 'create-contract-v1', text: '\\"\n😀'.repeat(10000), null: null, absent: {}, rows: [[1, 2], [null]] };
const collect = (value: unknown, maxBytes = 65536, ctx = context()) => {
  const pages: DeliveryPage[] = [];
  let cursor: string | undefined;
  do {
    const response = deliverComplete(value, { format: 'compact-json-v1', maxBytes, ...(cursor ? { cursor } : {}) }, ctx);
    expect(responseBytes(process.env.MAAD_EMIT_REQUEST_ID === 'true' ? attachMeta(response, { request_id: ctx.requestId }) : response)).toBeLessThanOrEqual(maxBytes);
    const parsed = parse(response);
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    const page = parsed.data as DeliveryPage;
    pages.push(page); cursor = page.nextCursor ?? undefined;
    expect(pages.length).toBeLessThan(512);
  } while (cursor);
  return pages;
};
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); setProvenanceMode('off'); });

describe('complete delivery and independent budgets', () => {
  it('losslessly handles null versus absent, reserved keys and tagged-array lookalikes', () => {
    const value = JSON.parse('{"__proto__":{"safe":true},"constructor":null,"a":[0,[1,0]],"empty":{},"nil":null}');
    expect(expandCompactJson(compactJson(value))).toEqual(value);
    expect(() => expandCompactJson({ encoding: 'shape-json-v1', shapes: [[['a'], ['a']]], value: [1, 0, 1] })).toThrow();
  });
  it('reconstructs dense arrays without counting encoding tags against the original node budget', () => {
    const value = Array.from({ length: 40000 }, () => []);
    expect(expandCompactJson(compactJson(value))).toEqual(value);
  });
  it('rejects repeated null shapes before expanding past the canonical node bound', () => {
    const keys = Array.from({ length: 500 }, (_, i) => `key${i}`);
    const packed = { encoding: 'shape-json-v1' as const, shapes: [[[], keys]] as [string[], string[]][],
      value: [0, ...Array.from({ length: 100 }, () => [1, 0])] };
    expect(() => expandCompactJson(packed)).toThrow('Compact structure exceeds bounds');
    const allowed = Object.fromEntries(Array.from({ length: 32767 }, (_, i) => [`key${i}`, null]));
    expect(expandCompactJson(compactJson(allowed))).toEqual(allowed);
  });
  it('charges repeated long shape keys against the expanded byte bound', () => {
    const packed = { encoding: 'shape-json-v1' as const, shapes: [[[], ['k'.repeat(30000)]]] as [string[], string[]][],
      value: [0, ...Array.from({ length: 100 }, () => [1, 0])] };
    expect(() => expandCompactJson(packed)).toThrow('Compact structure exceeds bounds');
  });
  it('permits distinct shape metadata for content within the original v1 node limit', () => {
    const value = Array.from({ length: 16400 }, (_, i) => ({ [i.toString(36)]: null }));
    expect(() => canonicalJson(value)).not.toThrow();
    expect(expandCompactJson(compactJson(value))).toEqual(value);
  });
  it('delivers valid v1 receipt content with fixed wrapper overhead near the node limit', () => {
    const raw = Buffer.from('---\ndoc_id: n-one\ndoc_type: note\nschema: note.v1\nvalues: [' + Array(65520).fill('0').join(',') + ']\n---\n');
    const content = parseReceiptContent(raw, 'n-one', 'note', 'note.v1');
    const receipt = { contract: 'document-persistence-v1', engineVersion: 'test', project: 'example',
      docId: 'n-one', docType: 'note', observedAt: new Date().toISOString(), effectiveHistoryMode: 'git',
      projection: 'document-content-v1', expectedContentDigest: null, status: 'committed_content_available', reason: null,
      index: { state: 'present' }, workingTree: { state: 'matches_committed', rawSha256: 'a'.repeat(64), contentDigest: content.contentDigest },
      committed: { ...content, evidenceKind: 'git_commit_visible', objectFormat: 'sha1', commitOid: 'a'.repeat(40), treeOid: 'b'.repeat(40),
        blobOid: 'c'.repeat(40), rawSha256: 'a'.repeat(64), byteLength: raw.length }, expectedDigestMatch: null };
    expect(() => canonicalJson(receipt)).toThrow('Content structure exceeds bounds');
    expect(assembleCompleteDelivery(collect(receipt))).toEqual(receipt);
  });
  it('returns an actionable structured error when complete data exceeds delivery bounds', () => {
    const result = parse(deliverComplete({ values: Array(66000).fill(0) }, { format: 'compact-json-v1' }, context()));
    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe('RECEIPT_CONTENT_INVALID');
    expect(result.errors[0].details).toMatchObject({ tool: 'maad_create_contract', capNodes: 65792 });
  });
  it('invalidates delivery when runtime resources are replaced on the same engine', () => {
    const ctx = context();
    const first = parse(deliverComplete(data, { format: 'compact-json-v1', maxBytes: 8192 }, ctx)).data as DeliveryPage;
    vi.spyOn(ctx.engine, 'getReceiptEpoch').mockReturnValue({});
    expect(parse(deliverComplete(data, { format: 'compact-json-v1', cursor: first.nextCursor! }, ctx)).ok).toBe(false);
  });
  it('counts UTF-8 escaping and metadata at/below/above the complete boundary', () => {
    const result = attachMeta(successResponse({ text: '\\"😀\n'.repeat(500) }), { request_id: 'id' });
    const bytes = responseBytes(result);
    for (const delta of [-1, 0, 1]) {
      vi.stubEnv('MAAD_RESPONSE_MAX_BYTES', String(bytes + delta));
      expect(parse(guardResponseSize(result, { tool: 'maad_query' })).ok).toBe(delta >= 0);
    }
    vi.stubEnv('MAAD_RESPONSE_MAX_BYTES', '100');
    expect(responseMaxBytes()).toBe(100); expect(contractResponseMaxBytes()).toBe(131072);
    vi.stubEnv('MAAD_CONTRACT_RESPONSE_MAX_BYTES', '2000000'); expect(contractResponseMaxBytes()).toBe(1048576);
  });
  it.each([8192, 65536, 131072])('reconstructs complete escaped Unicode content within %i bytes per page', cap => {
    vi.stubEnv('MAAD_EMIT_REQUEST_ID', 'true'); setProvenanceMode('on');
    const pages = collect(data, cap);
    expect(assembleCompleteDelivery(pages)).toEqual(data);
  });
  it('rejects missing, duplicate, reordered, tampered, mixed and expired pages', () => {
    const pages = collect(data); expect(pages.length).toBeGreaterThan(1);
    const other = collect({ ...data, null: 'different' });
    for (const bad of [pages.slice(1), pages.slice(0, -1), [pages[0]!, ...pages], [...pages].reverse(),
      [other[0]!, ...pages.slice(1)], [{ ...pages[0]!, chunk: 'x' + pages[0]!.chunk.slice(1) }, ...pages.slice(1)]]) {
      expect(() => assembleCompleteDelivery(bad)).toThrow();
    }
    expect(() => assembleCompleteDelivery(pages, pages[0]!.expiresAt)).toThrow();
  });
  it('binds continuation to engine, session, request and unchanged complete observation', () => {
    const ctx = context(); const first = parse(deliverComplete(data, { format: 'compact-json-v1', maxBytes: 8192 }, ctx)).data as DeliveryPage;
    const input = { format: 'compact-json-v1' as const, cursor: first.nextCursor! };
    for (const wrong of [{ ...ctx, sessionId: 'other' }, { ...ctx, engine: context().engine }, { ...ctx, request: { docType: 'other' } }]) {
      expect(parse(deliverComplete(data, input, wrong)).ok).toBe(false);
    }
    expect(parse(deliverComplete({ ...data, changed: true }, input, ctx)).ok).toBe(false);
    expect(parse(deliverComplete(data, input, ctx)).ok).toBe(false);
  });
  it('expires snapshots and bounds retention across sessions and per engine', () => {
    const ctx = context();
    const first = parse(deliverComplete(data, { format: 'compact-json-v1', maxBytes: 8192 }, ctx)).data as DeliveryPage;
    vi.spyOn(Date, 'now').mockReturnValue(first.expiresAt);
    expect(parse(deliverComplete(data, { format: 'compact-json-v1', cursor: first.nextCursor! }, ctx)).ok).toBe(false);
    vi.restoreAllMocks();
    const current = context();
    const old = parse(deliverComplete(data, { format: 'compact-json-v1', maxBytes: 8192 }, current)).data as DeliveryPage;
    for (let n = 0; n < 2; n++) deliverComplete(data, { format: 'compact-json-v1', maxBytes: 8192 }, current);
    expect(parse(deliverComplete(data, { format: 'compact-json-v1', cursor: old.nextCursor! }, current)).ok).toBe(false);
    const retained = parse(deliverComplete(data, { format: 'compact-json-v1', maxBytes: 8192 }, current)).data as DeliveryPage;
    for (let n = 0; n < 17; n++) deliverComplete(data, { format: 'compact-json-v1', maxBytes: 8192 }, context());
    expect(parse(deliverComplete(data, { format: 'compact-json-v1', cursor: retained.nextCursor! }, current)).ok).toBe(false);
  });
});
