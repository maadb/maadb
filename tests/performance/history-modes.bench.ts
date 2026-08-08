import { bench, describe } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { MaadEngine } from '../../src/engine.js';
import type { ResolvedHistoryConfig } from '../../src/history/types.js';
import { docType } from '../../src/types.js';

interface StageSample {
  file_index_ms: number;
  git_add_ms: number;
  git_status_ms: number;
  commit_ms: number;
  total_ms: number;
}

const enabled = process.env.MAAD_HISTORY_BENCH === '1';
const samples: StageSample[] = [];
let root: string | undefined;
let sequence = 0;

const feedConfig: ResolvedHistoryConfig = {
  effectiveMode: 'feed',
  configuredMode: 'feed',
  modeSource: 'project',
  options: {},
  advisories: [],
};

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function mean(field: keyof StageSample): number {
  return samples.reduce((total, sample) => total + sample[field], 0) / samples.length;
}

describe('history mode write-stage benchmark', () => {
  bench.skipIf(!enabled)(
    'generated Markdown/index/Git pipeline',
    async () => {
      sequence += 1;
      root = mkdtempSync(path.join(tmpdir(), 'maad-history-bench-'));
      mkdirSync(path.join(root, '_registry'), { recursive: true });
      mkdirSync(path.join(root, '_schema'), { recursive: true });
      mkdirSync(path.join(root, 'data', 'notes'), { recursive: true });
      writeFileSync(
        path.join(root, '_registry', 'object_types.yaml'),
        'types:\n  note:\n    path: data/notes\n    id_prefix: note\n    schema: note.v1\n',
        'utf8',
      );
      writeFileSync(
        path.join(root, '_schema', 'note.v1.yaml'),
        'type: note\nversion: 1\nrequired: [doc_id, title]\nfields:\n  title:\n    type: string\n    index: true\n',
        'utf8',
      );
      writeFileSync(path.join(root, '.gitignore'), '_backend/\n', 'utf8');

      const git = simpleGit(root);
      await git.init();
      await git.addConfig('user.email', 'noreply@example.invalid');
      await git.addConfig('user.name', 'History Benchmark');
      await git.add('.');
      await git.commit('fixture: initial state');

      const engine = new MaadEngine();
      const initialized = await engine.init(root, { history: feedConfig });
      if (!initialized.ok) {
        throw new Error(initialized.errors.map(error => `${error.code}: ${error.message}`).join('; '));
      }
      const id = `note-bench-${sequence}`;
      const totalStart = nowMs();
      try {
        const fileIndexStart = nowMs();
        const created = await engine.createDocument(
          docType('note'),
          { title: `Generated note ${sequence}` },
          'Generated benchmark body.',
          id,
        );
        if (!created.ok) throw new Error(created.errors.map(error => error.message).join('; '));
        const fileIndexEnd = nowMs();

        const addStart = nowMs();
        await git.add(path.posix.join('data', 'notes', `${id}.md`));
        const addEnd = nowMs();

        const statusStart = nowMs();
        await git.status();
        const statusEnd = nowMs();

        const commitStart = nowMs();
        await git.commit(`benchmark: ${id}`);
        const commitEnd = nowMs();

        samples.push({
          file_index_ms: fileIndexEnd - fileIndexStart,
          git_add_ms: addEnd - addStart,
          git_status_ms: statusEnd - statusStart,
          commit_ms: commitEnd - commitStart,
          total_ms: commitEnd - totalStart,
        });
        if (samples.length === 5) {
          const report = {
            fixture: 'generated',
            samples: samples.length,
            mean_ms: {
              file_index: mean('file_index_ms'),
              git_add: mean('git_add_ms'),
              git_status: mean('git_status_ms'),
              commit: mean('commit_ms'),
              total: mean('total_ms'),
            },
          };
          console.log(`MAAD_HISTORY_BENCH ${JSON.stringify(report)}`);
        }
      } finally {
        await engine.close();
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        root = undefined;
      }
    },
    { iterations: 5, time: 0, warmupIterations: 0, warmupTime: 0 },
  );
});
