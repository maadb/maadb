import { it, expect } from 'vitest';
import { performance } from 'node:perf_hooks';
import { statSync } from 'node:fs';
import path from 'node:path';
import { scopeFixture } from './scope-fixture.js';
import { semanticSearch } from '../../src/engine/semantic/search.js';

it('measures scoped exact search at 1000 and 10000 documents', async () => {
  for (const size of [1000, 10000]) {
    const fixture = scopeFixture(size);
    try {
      for (const query of ['uniqueneedle', 'routine']) {
        const samples: number[] = [];
        let firstMs = 0;
        for (let i = 0; i < 36; i++) {
          const start = performance.now();
          const r = await semanticSearch(fixture.ctx, {
            query, mode: 'exact', docType: 'note', filters: { access: 'public' }, k: 10,
          });
          const elapsed = performance.now() - start;
          if (i === 0) firstMs = elapsed;
          if (i >= 6) samples.push(elapsed);
          expect(r.ok && r.value.total).toBe(query === 'uniqueneedle' ? 1 : 10);
        }
        samples.sort((a, b) => a - b);
        process.stdout.write(JSON.stringify({ documents: size, blocks: size, query, samples: samples.length,
          firstMs, p50Ms: samples[14], p95Ms: samples[28], p99Ms: samples[29],
          rssBytes: process.memoryUsage().rss,
          databaseBytes: statSync(path.join(fixture.root, 'index.db')).size,
          runtime: process.version, platform: process.platform, arch: process.arch,
        }) + "\n");
      }
    } finally { fixture.close(); }
  }
});
