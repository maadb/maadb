import { statSync } from 'node:fs';
import type { SchemaStore } from '../types.js';

/** One bounded, private preparation per engine; never stores authority or history. */
export class ContractPreparationCache {
  private entry: { key: string; schemas: SchemaStore['schemas'] } | undefined;

  clear(): void { this.entry = undefined; }

  get(key: string, cachedFiles: SchemaStore['cachedFiles']): SchemaStore | undefined {
    if (this.entry?.key !== key) return undefined;
    // Neither callers nor the activated legacy store can mutate cached definitions.
    const schemas = structuredClone(this.entry.schemas);
    const files = new Map(cachedFiles);
    return {
      schemas, cachedFiles: files,
      getSchema: ref => schemas.get(ref),
      getSchemaForType: type => [...schemas.values()].find(schema => schema.type === type),
      isStale: () => [...files].some(([file, expected]) => {
        try {
          const actual = statSync(file);
          return actual.mtimeMs !== expected.mtimeMs || actual.size !== expected.size;
        } catch { return true; }
      }),
    };
  }

  set(key: string, store: SchemaStore): void {
    this.entry = { key, schemas: structuredClone(store.schemas) };
  }
}
