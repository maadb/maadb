// ============================================================================
// History Modes - shared configuration and runtime contracts
// ============================================================================

import type { CommitOptions, CommitOutcome } from '../git/index.js';

export const HISTORY_MODES = ['audit', 'feed', 'read', 'batch', 'snapshot'] as const;

export type HistoryMode = (typeof HISTORY_MODES)[number];

/** How the effective mode was selected for a project. */
export type HistoryModeSource = 'project' | 'environment' | 'inferred';

/** Public `history_options` shape from instance.yaml. */
export interface HistoryOptions {
  max_writes?: number;
  max_delay_ms?: number;
}

export interface HistoryAdvisory {
  code: 'HISTORY_MODE_INFERRED';
  message: string;
}

/** Fully resolved history configuration passed from the pool to the engine. */
export interface ResolvedHistoryConfig {
  effectiveMode: HistoryMode;
  /** The project-level `history_mode`, excluding environment defaults. */
  configuredMode: HistoryMode | null;
  modeSource: HistoryModeSource;
  options: HistoryOptions;
  advisories: HistoryAdvisory[];
}

export type HistoryFlushTrigger =
  | 'threshold'
  | 'timer'
  | 'explicit'
  | 'shutdown'
  | 'recovery'
  | 'snapshot';

export interface HistoryFlushError {
  at: string;
  code: string;
  message: string;
  trigger: HistoryFlushTrigger;
}

/** Stable history portion of engine health. */
export interface HistoryHealthState {
  effectiveMode: HistoryMode;
  configuredMode: HistoryMode | null;
  modeSource: HistoryModeSource;
  pendingWrites: number;
  lastSuccessfulFlush: string | null;
  lastFlushError: HistoryFlushError | null;
  advisories: HistoryAdvisory[];
}

export interface HistoryFlushResult {
  trigger: HistoryFlushTrigger;
  pendingWrites: number;
  outcome: CommitOutcome;
}

/**
 * Engine-facing seam implemented by the history runtime. Keeping this on the
 * context lets write paths delegate commit policy without knowing whether the
 * effective mode commits immediately, batches, or disables Git.
 */
export interface HistoryRuntime {
  readonly config: ResolvedHistoryConfig;
  commit(options: CommitOptions): Promise<CommitOutcome>;
  flush(trigger: HistoryFlushTrigger): Promise<HistoryFlushResult>;
  health(): HistoryHealthState;
  close(): Promise<void>;
}
