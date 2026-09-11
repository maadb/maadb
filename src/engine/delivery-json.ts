import { canonicalJson } from './document-receipt.js';

// Delivery contains an already-validated v1 value plus receipt/contract metadata
// and raw content copies. These allowances do not change v1 admission limits.
export const DELIVERY_JSON_LIMITS = Object.freeze({ nodes: 65536 + 256, depth: 64 + 4, scalarBytes: 2 * 1024 * 1024 });
export const canonicalDeliveryJson = (value: unknown): string => canonicalJson(value, DELIVERY_JSON_LIMITS);
