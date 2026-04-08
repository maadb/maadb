// ============================================================================
// MCP Config — runtime configuration for the server
// Single source of truth for project root, role, flags.
// ============================================================================

import { parseRole, type Role } from './roles.js';

export type ProvenanceMode = 'off' | 'on' | 'detail';

export interface McpConfig {
  projectRoot: string;
  role: Role;
  dryRun: boolean;
  toolAllowlist: string[];
  provenance: ProvenanceMode;
}

export function parseProvenance(raw: string | undefined): ProvenanceMode {
  if (raw === 'on' || raw === 'detail') return raw;
  return 'off';
}

export function buildConfig(opts: {
  projectRoot: string;
  role?: string | undefined;
  dryRun?: boolean | undefined;
  toolAllowlist?: string[] | undefined;
  provenance?: string | undefined;
}): McpConfig {
  return {
    projectRoot: opts.projectRoot,
    role: parseRole(opts.role),
    dryRun: opts.dryRun ?? false,
    toolAllowlist: opts.toolAllowlist ?? [],
    provenance: parseProvenance(opts.provenance),
  };
}
