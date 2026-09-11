import { canonicalJson } from './document-receipt.js';
import { canonicalDeliveryJson, DELIVERY_JSON_LIMITS } from './delivery-json.js';
import type { JsonValue } from './document-receipt-types.js';

export interface CompactJson {
  encoding: 'shape-json-v1';
  /** Each shape lists value keys, then keys whose value is exactly null. */
  shapes: [string[], string[]][];
  value: JsonValue;
}

/** Lossless JSON encoding. Arrays use [0,...items], objects [1,shape,...values]. */
export function compactJson(input: unknown): CompactJson {
  const source = JSON.parse(canonicalDeliveryJson(input)) as JsonValue;
  const shapes: CompactJson['shapes'] = [];
  const indices = new Map<string, number>();
  const encode = (value: JsonValue): JsonValue => {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return [0, ...value.map(encode)];
    const keys = Object.keys(value).sort();
    const shape: [string[], string[]] = [keys.filter(k => value[k] !== null), keys.filter(k => value[k] === null)];
    const signature = JSON.stringify(shape);
    let index = indices.get(signature);
    if (index === undefined) { index = shapes.length; shapes.push(shape); indices.set(signature, index); }
    return [1, index, ...shape[0].map(k => encode(value[k]!))];
  };
  const value = encode(source);
  return { encoding: 'shape-json-v1', shapes, value };
}

/** Reference decoder: bounded input, exact arity, no prototype assignment. */
export function expandCompactJson(input: CompactJson): JsonValue {
  // Tags add nodes that are absent from the expanded value. Bound shapes
  // independently; the decoder and final canonicalization bound expanded data.
  canonicalJson({ encoding: input.encoding, shapes: input.shapes }, {
    nodes: DELIVERY_JSON_LIMITS.nodes * 4, depth: 5, scalarBytes: DELIVERY_JSON_LIMITS.scalarBytes,
  });
  if (input.encoding !== 'shape-json-v1' || !Array.isArray(input.shapes)) throw new Error('Invalid compact encoding');
  for (const shape of input.shapes) {
    if (!Array.isArray(shape) || shape.length !== 2 || !shape.every(keys => Array.isArray(keys) && keys.every(k => typeof k === 'string'))
      || new Set(shape.flat()).size !== shape.flat().length) throw new Error('Invalid compact shape');
  }
  let nodes = 0;
  let bytes = 0;
  const charge = (count: number, size: number, depth: number): void => {
    nodes += count;
    bytes += size;
    if (nodes > DELIVERY_JSON_LIMITS.nodes || depth > DELIVERY_JSON_LIMITS.depth || bytes > DELIVERY_JSON_LIMITS.scalarBytes) throw new Error('Compact structure exceeds bounds');
  };
  // Charge repeated property names and omitted nulls before allocating each
  // object. A small shape table must not amplify into unbounded decoded data.
  const costs = input.shapes.map(([keys, nullKeys]) => ({
    nodes: keys.length + nullKeys.length * 2,
    bytes: [...keys, ...nullKeys].reduce((sum, key) => sum + Buffer.byteLength(JSON.stringify(key)), nullKeys.length * 4),
  }));
  const decode = (value: JsonValue, depth: number): JsonValue => {
    charge(1, 0, depth);
    if (value === null || typeof value !== 'object') {
      if (!(value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))) throw new Error('Invalid compact primitive');
      charge(0, Buffer.byteLength(JSON.stringify(value)), depth);
      return value;
    }
    if (!Array.isArray(value)) throw new Error('Invalid compact node');
    if (value[0] === 0) {
      const result: JsonValue[] = [];
      for (let i = 1; i < value.length; i++) result.push(decode(value[i]!, depth + 1));
      return result;
    }
    const index = value[1];
    const shape = typeof index === 'number' && Number.isInteger(index) ? input.shapes[index] : undefined;
    if (value[0] !== 1 || !shape || value.length !== shape[0].length + 2) throw new Error('Invalid compact object');
    const cost = costs[index as number]!;
    charge(cost.nodes, cost.bytes, cost.nodes ? depth + 1 : depth);
    const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const key of shape[1]) result[key] = null;
    shape[0].forEach((key, i) => { result[key] = decode(value[i + 2]!, depth + 1); });
    return result;
  };
  const value = decode(input.value, 0);
  canonicalDeliveryJson(value);
  return value;
}
