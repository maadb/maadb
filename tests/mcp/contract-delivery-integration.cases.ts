// Shared with the real MCP guarded-create fixture via an explicit registration function.
import { expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { contractCorpus } from '../fixtures/contract-corpus.js';
import { assembleCompleteDelivery, canonicalJson, type DeliveryPage, type MaadEngine } from '../../src/engine.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export function deliveryCases(fixture: () => { root: string; engine: MaadEngine; client: Client; args: Record<string, unknown> }) {
  const contractArgs = { contract: 'create-contract-v1', docType: 'note' };
  const call = async (name: string, input: Record<string, unknown>) => {
    const wire = await fixture().client.callTool({ name, arguments: input });
    const result = JSON.parse((wire.content as Array<{ text: string }>)[0]!.text);
    return { result, bytes: Buffer.byteLength(JSON.stringify(wire)) };
  };
  const install = () => {
    for (const [file, text] of Object.entries(contractCorpus())) writeFileSync(path.join(fixture().root, file), text);
  };
  const collect = async (name: string, input: Record<string, unknown>, maxBytes = 65536) => {
    const pages: DeliveryPage[] = [];
    let cursor: string | undefined;
    do {
      const { result, bytes } = await call(name, { ...input,
        delivery: { format: 'compact-json-v1', maxBytes, ...(cursor ? { cursor } : {}) } });
      expect(bytes).toBeLessThanOrEqual(maxBytes);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      pages.push(result.data); cursor = result.data.nextCursor ?? undefined;
      expect(pages.length).toBeLessThan(512);
    } while (cursor);
    return pages;
  };

  it('delivers 24 types under 100000 bytes and independently verifies the unchanged v1 schema digest', async () => {
    install();
    vi.stubEnv('MAAD_CONTRACT_RESPONSE_MAX_BYTES', '1048576');
    const full = await call('maad_create_contract', contractArgs);
    expect(full.result.ok).toBe(true); expect(full.bytes).toBeGreaterThan(65536);
    vi.stubEnv('MAAD_CONTRACT_RESPONSE_MAX_BYTES', '131072');
    vi.stubEnv('MAAD_RESPONSE_MAX_BYTES', '65536'); vi.stubEnv('MAAD_EMIT_REQUEST_ID', 'true');
    const compact = await call('maad_create_contract', { ...contractArgs, delivery: { format: 'compact-json-v1' } });
    expect(compact.result.ok, JSON.stringify(compact.result)).toBe(true);
    expect(compact.result.data.complete).toBe(true); expect(compact.bytes).toBeLessThan(100000);
    expect(assembleCompleteDelivery([compact.result.data])).toEqual(full.result.data);
    // Independent decoder and canonicalization, without the production helpers.
    const encoded = JSON.parse(compact.result.data.chunk);
    const decode = (v: unknown): unknown => {
      if (!Array.isArray(v)) return v;
      if (v[0] === 0) return v.slice(1).map(decode);
      const [keys, nulls] = encoded.shapes[v[1]] as [string[], string[]];
      return Object.fromEntries([...nulls.map(k => [k, null]), ...keys.map((k, i) => [k, decode(v[i + 2])])]);
    };
    const canonical = (v: unknown): string => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']'
      : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical((v as Record<string, unknown>)[k])).join(',') + '}' : JSON.stringify(v);
    const reconstructed = decode(encoded.value) as Record<string, unknown>;
    expect(reconstructed).toEqual(full.result.data);
    expect(hash(canonical(reconstructed.schemaContract))).toBe(full.result.data.schemaDigest);
    const pages = await collect('maad_create_contract', contractArgs);
    expect(assembleCompleteDelivery(pages)).toEqual(full.result.data);
    expect((await call('maad_create_guarded', { ...fixture().args, expectedSchemaDigest: full.result.data.schemaDigest })).result.ok).toBe(true);
    console.log(JSON.stringify({ fixture: 'synthetic-24-types-408-fields', fullBytes: full.bytes, compactBytes: compact.bytes, pages64KiB: pages.length }));
  });
  it('rejects a changed schema during paged observation', async () => {
    install();
    const delivery = { format: 'compact-json-v1', maxBytes: 8192 };
    const first = await call('maad_create_contract', { ...contractArgs, delivery });
    expect(first.result.ok).toBe(true); expect(first.result.data.complete).toBe(false);
    const file = path.join(fixture().root, '_schema/note.v1.yaml');
    writeFileSync(file, readFileSync(file, 'utf8') + '# changed\n');
    const changed = await call('maad_create_contract', { ...contractArgs, delivery: { ...delivery, cursor: first.result.data.nextCursor } });
    expect(changed.result.errors[0].code).toBe('RECEIPT_OBSERVATION_CHANGED');
  });
  it('invalidates a cursor after reloading the same ready engine', async () => {
    install();
    const delivery = { format: 'compact-json-v1', maxBytes: 8192 };
    const first = await call('maad_create_contract', { ...contractArgs, delivery });
    expect(first.result.ok).toBe(true); expect(first.result.data.complete).toBe(false);
    expect((await fixture().engine.reload()).ok).toBe(true);
    const changed = await call('maad_create_contract', { ...contractArgs, delivery: { ...delivery, cursor: first.result.data.nextCursor } });
    expect(changed.result.errors[0].code).toBe('RECEIPT_OBSERVATION_CHANGED');
  });
  it('keeps large exact receipts recoverable after an oversized write acknowledgement', async () => {
    const body = 'Body with "quotes" and Unicode 😀.\n'.repeat(3000).trim();
    const frontmatter = { doc_id: 'nt-one', doc_type: 'note', schema: 'note.v1', title: 'Hello' };
    const digest = hash('{"docId":"nt-one","docType":"note","frontmatter":' + canonicalJson(frontmatter) + ',"body":' + JSON.stringify(body) + '}');
    vi.stubEnv('MAAD_CONTRACT_RESPONSE_MAX_BYTES', '100');
    const write = await call('maad_create_guarded', { ...fixture().args, body, expectedContentDigest: digest });
    expect(write.result.errors[0].details.writeOutcome).toBe('unknown_reconcile');
    expect(readFileSync(path.join(fixture().root, 'notes/nt-one.md'), 'utf8')).toContain('title: Hello');
    vi.stubEnv('MAAD_CONTRACT_RESPONSE_MAX_BYTES', '131072');
    const input = { contract: 'document-persistence-v1', docType: 'note', docId: 'nt-one', expectedContentDigest: digest };
    expect((await call('maad_document_receipt', input)).result.errors[0].code).toBe('RESPONSE_TOO_LARGE');
    const receipt = assembleCompleteDelivery(await collect('maad_document_receipt', input)) as Record<string, unknown>;
    expect(receipt.expectedDigestMatch).toBe(true);
    expect((receipt.committed as Record<string, unknown>).body).toBe(body);
  });
}
