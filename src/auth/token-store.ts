// ============================================================================
// TokenStore — 0.7.0 Scoped Auth registry primitive (dec-maadb-069 +
//              dec-maadb-071)
//
// Loads and mutates `<instance-root>/_auth/tokens.yaml`. In-memory indexes
// by hash (lookup key) and by id (CLI / admin tools). Writes are atomic via
// tmp-file + rename.
//
// Scope of this module:
//   - load, lookupByHash, lookupById, list, stats
//   - issue (generates plaintext + hash, persists)
//   - revoke (sets revokedAt, persists)
//   - rotate (revokes old + issues new with preserved capabilities)
//
// NOT in scope here (later phases):
//   - HTTP middleware resolveToken() — uses this store but lives in mcp/transport/auth.ts (P2)
//   - Three-cap role composition — with-session.ts (P2)
//   - CLI + admin MCP tools that call issue/revoke/rotate — P3
// ============================================================================

import { existsSync } from 'node:fs';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import yaml from 'js-yaml';

import { ok, singleErr, type Result } from '../errors.js';
import {
  tokenId as toTokenId,
  tokenHash as toTokenHash,
  type TokenId,
  type TokenHash,
  type TokenRecord,
  type IssueSpec,
  type IssuedToken,
  type TokensFileShape,
  type ProjectCap,
} from './types.js';

const TOKEN_PLAINTEXT_PREFIX = 'maad_pat_';
const TOKEN_PLAINTEXT_RANDOM_BYTES = 16;   // 128 bits → 32 hex chars
const TOKEN_ID_RANDOM_BYTES = 6;            // 48 bits → 12 hex chars

export const TOKENS_FILE_RELATIVE = path.join('_auth', 'tokens.yaml');

/**
 * Generate a new plaintext bearer in the locked format: maad_pat_<32hex>.
 * Shell-safe (hex only), 128 bits random, prefix visible in logs / scanners.
 */
export function generatePlaintext(): string {
  const random = randomBytes(TOKEN_PLAINTEXT_RANDOM_BYTES).toString('hex');
  return `${TOKEN_PLAINTEXT_PREFIX}${random}`;
}

/** Plaintext → SHA-256 hex. The sole lookup key that persists. */
export function hashPlaintext(plaintext: string): TokenHash {
  return toTokenHash(createHash('sha256').update(plaintext, 'utf8').digest('hex'));
}

/** Format check — cheap defensive filter before hashing arbitrary bearers. */
export function looksLikeToken(bearer: string): boolean {
  if (!bearer.startsWith(TOKEN_PLAINTEXT_PREFIX)) return false;
  const random = bearer.slice(TOKEN_PLAINTEXT_PREFIX.length);
  return /^[0-9a-f]{32}$/.test(random);
}

function generateId(): TokenId {
  return toTokenId(`tok-${randomBytes(TOKEN_ID_RANDOM_BYTES).toString('hex')}`);
}

export class TokenStore {
  private byHash = new Map<TokenHash, TokenRecord>();
  private byId = new Map<TokenId, TokenRecord>();
  private records: TokenRecord[] = [];

  private constructor(
    private filePath: string,
    private registryName: string | undefined,
  ) {}

  /**
   * Load tokens.yaml from `<instanceRoot>/_auth/tokens.yaml`. Returns an empty
   * store if the file is absent — caller decides whether HTTP mode can boot
   * against that state (the HTTP boot-mode matrix in the 0.7.0 spec).
   *
   * Parse errors are NOT silent: TOKENS_FILE_INVALID is returned with the
   * file path + js-yaml message so operators can fix the file without
   * guessing.
   */
  static async load(instanceRoot: string): Promise<Result<TokenStore>> {
    const filePath = path.join(instanceRoot, TOKENS_FILE_RELATIVE);
    const store = new TokenStore(filePath, undefined);

    if (!existsSync(filePath)) return ok(store);

    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (e) {
      return singleErr('TOKENS_FILE_INVALID',
        `Failed to read tokens file ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
    }

    let data: unknown;
    try {
      data = yaml.load(raw);
    } catch (e) {
      return singleErr('TOKENS_FILE_INVALID',
        `tokens.yaml parse error at ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
    }

    const shape = validateShape(data, filePath);
    if (!shape.ok) return shape;

    store.registryName = shape.value.name;
    for (const raw of shape.value.tokens) {
      const record = normalizeRecord(raw);
      store.records.push(record);
      store.byHash.set(record.hash, record);
      store.byId.set(record.id, record);
    }
    return ok(store);
  }

  /** Absolute path to the backing file. */
  path(): string { return this.filePath; }

  /** Optional human label recorded at the top of tokens.yaml. */
  name(): string | undefined { return this.registryName; }

  /** Total records including revoked. */
  size(): number { return this.records.length; }

  /** Records with no revokedAt and no expiresAt-in-the-past. */
  activeCount(now: Date = new Date()): number {
    let n = 0;
    for (const r of this.records) if (isActive(r, now)) n++;
    return n;
  }

  /** O(1) lookup by hash. Returns undefined for unknown bearers. */
  lookupByHash(hash: TokenHash): TokenRecord | undefined {
    return this.byHash.get(hash);
  }

  /** Secondary lookup by readable id (CLI / admin paths). */
  lookupById(id: TokenId): TokenRecord | undefined {
    return this.byId.get(id);
  }

  /** Snapshot of all records. Caller receives a shallow copy. */
  list(): TokenRecord[] { return [...this.records]; }

  /**
   * Issue a new token. Generates plaintext + hash, appends the record,
   * persists the file atomically. Returns both the record and the plaintext —
   * plaintext is never recoverable after this call.
   */
  async issue(spec: IssueSpec): Promise<Result<IssuedToken>> {
    const plaintext = generatePlaintext();
    const hash = hashPlaintext(plaintext);

    // Defensive: SHA-256 collisions are astronomically unlikely but we still
    // refuse to persist a duplicate hash rather than silently overwrite.
    if (this.byHash.has(hash)) {
      return singleErr('TOKEN_MALFORMED',
        'hash collision on newly generated plaintext; retry');
    }

    const record: TokenRecord = {
      id: generateId(),
      hash,
      role: spec.role,
      projects: spec.projects,
      createdAt: new Date().toISOString(),
    };
    if (spec.name !== undefined) record.name = spec.name;
    if (spec.agentId !== undefined) record.agentId = spec.agentId;
    if (spec.userId !== undefined) record.userId = spec.userId;
    if (spec.expiresAt !== undefined) record.expiresAt = spec.expiresAt;

    this.records.push(record);
    this.byHash.set(record.hash, record);
    this.byId.set(record.id, record);

    const persisted = await this.persist();
    if (!persisted.ok) {
      // Roll back in-memory state so the store stays consistent with disk.
      this.records.pop();
      this.byHash.delete(record.hash);
      this.byId.delete(record.id);
      return persisted;
    }
    return ok({ record, plaintext });
  }

  /**
   * Mark a token as revoked. Sets revokedAt; the record stays in the registry
   * so audit queries can resolve historic token IDs. Idempotent — revoking
   * an already-revoked record is a no-op and returns the existing record.
   */
  async revoke(id: TokenId): Promise<Result<TokenRecord>> {
    const record = this.byId.get(id);
    if (!record) return singleErr('TOKEN_NOT_FOUND', `No token with id ${id as string}`);
    if (record.revokedAt !== undefined) return ok(record);

    record.revokedAt = new Date().toISOString();
    const persisted = await this.persist();
    if (!persisted.ok) {
      delete record.revokedAt;
      return persisted;
    }
    return ok(record);
  }

  /**
   * Rotate a token: issue a new token with the SAME capabilities (role,
   * projects, agentId, userId, expiresAt, name) and revoke the old one.
   * Immediate cutover — no grace window (deferred per dec-maadb-069 lock #10).
   * Returns the new record + plaintext; old record retains its id with
   * revokedAt set.
   */
  async rotate(id: TokenId): Promise<Result<IssuedToken>> {
    const existing = this.byId.get(id);
    if (!existing) return singleErr('TOKEN_NOT_FOUND', `No token with id ${id as string}`);
    if (existing.revokedAt !== undefined) {
      return singleErr('TOKEN_REVOKED',
        `Token ${id as string} is already revoked; rotate requires an active token`);
    }

    // Build IssueSpec from the existing record's capabilities. Cloning
    // projects array defensively so mutations on the new record never leak.
    const spec: IssueSpec = {
      role: existing.role,
      projects: existing.projects.map(p => ({ ...p })),
    };
    if (existing.name !== undefined) spec.name = existing.name;
    if (existing.agentId !== undefined) spec.agentId = existing.agentId;
    if (existing.userId !== undefined) spec.userId = existing.userId;
    if (existing.expiresAt !== undefined) spec.expiresAt = existing.expiresAt;

    const issued = await this.issue(spec);
    if (!issued.ok) return issued;

    // Mark the old record revoked after the new one persists so a crash mid-rotate
    // leaves at most an extra active token, not a gap with neither.
    existing.revokedAt = new Date().toISOString();
    const persisted = await this.persist();
    if (!persisted.ok) {
      delete existing.revokedAt;
      return persisted;
    }
    return issued;
  }

  /**
   * Atomic write via `<path>.tmp` + rename. Creates `_auth/` if missing.
   * Errors don't leak partial state because writeFile+rename is atomic on
   * both POSIX and Windows.
   */
  private async persist(): Promise<Result<void>> {
    // Serialized shape uses snake_case keys for on-disk yaml; the in-memory
    // TokenRecord shape is camelCase. Keep them distinct here rather than
    // reshaping the public type.
    const shape: Record<string, unknown> = {
      ...(this.registryName !== undefined ? { name: this.registryName } : {}),
      tokens: this.records.map(serializeRecord),
    };
    const yamlText = yaml.dump(shape, { noRefs: true, lineWidth: 120 });

    const dir = path.dirname(this.filePath);
    try {
      await mkdir(dir, { recursive: true });
    } catch (e) {
      return singleErr('TOKENS_FILE_INVALID',
        `Failed to create ${dir}: ${e instanceof Error ? e.message : String(e)}`);
    }

    const tmp = `${this.filePath}.tmp`;
    try {
      await writeFile(tmp, yamlText, { encoding: 'utf8', mode: 0o600 });
      await rename(tmp, this.filePath);
    } catch (e) {
      return singleErr('TOKENS_FILE_INVALID',
        `Failed to persist tokens.yaml at ${this.filePath}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return ok(undefined);
  }
}

// --- Internal helpers ------------------------------------------------------

function validateShape(data: unknown, filePath: string): Result<TokensFileShape> {
  if (data === null || data === undefined) {
    // Empty file = empty registry.
    return ok({ tokens: [] });
  }
  if (typeof data !== 'object' || Array.isArray(data)) {
    return singleErr('TOKENS_FILE_INVALID',
      `tokens.yaml at ${filePath} must be a mapping, got ${Array.isArray(data) ? 'sequence' : typeof data}`);
  }
  const obj = data as Record<string, unknown>;

  const name = obj['name'];
  if (name !== undefined && typeof name !== 'string') {
    return singleErr('TOKENS_FILE_INVALID', `tokens.yaml \`name\` must be a string if present`);
  }

  const rawTokens = obj['tokens'];
  if (rawTokens === undefined) {
    return ok({ tokens: [], ...(typeof name === 'string' ? { name } : {}) });
  }
  if (!Array.isArray(rawTokens)) {
    return singleErr('TOKENS_FILE_INVALID', `tokens.yaml \`tokens\` must be an array`);
  }

  const tokens: TokenRecord[] = [];
  for (let i = 0; i < rawTokens.length; i++) {
    const entry = rawTokens[i];
    if (typeof entry !== 'object' || entry === null) {
      return singleErr('TOKENS_FILE_INVALID', `tokens[${i}] must be a mapping`);
    }
    const parsed = parseRecord(entry as Record<string, unknown>, i);
    if (!parsed.ok) return parsed;
    tokens.push(parsed.value);
  }

  const result: TokensFileShape = { tokens };
  if (typeof name === 'string') result.name = name;
  return ok(result);
}

function parseRecord(raw: Record<string, unknown>, index: number): Result<TokenRecord> {
  const loc = (f: string) => `tokens[${index}].${f}`;
  const getString = (f: string, required: boolean): Result<string | undefined> => {
    const v = raw[f];
    if (v === undefined) {
      if (required) return singleErr('TOKENS_FILE_INVALID', `${loc(f)} is required`);
      return ok(undefined);
    }
    if (typeof v !== 'string') return singleErr('TOKENS_FILE_INVALID', `${loc(f)} must be a string`);
    return ok(v);
  };

  const id = getString('id', true); if (!id.ok) return id;
  const hash = getString('hash', true); if (!hash.ok) return hash;
  const roleRaw = getString('role', true); if (!roleRaw.ok) return roleRaw;
  const createdAt = getString('created_at', true); if (!createdAt.ok) return createdAt;
  const name = getString('name', false); if (!name.ok) return name;
  const agentId = getString('agent_id', false); if (!agentId.ok) return agentId;
  const userId = getString('user_id', false); if (!userId.ok) return userId;
  const expiresAt = getString('expires_at', false); if (!expiresAt.ok) return expiresAt;
  const revokedAt = getString('revoked_at', false); if (!revokedAt.ok) return revokedAt;

  if (!['reader', 'writer', 'admin'].includes(roleRaw.value!)) {
    return singleErr('TOKENS_FILE_INVALID',
      `${loc('role')} must be one of reader|writer|admin, got ${roleRaw.value}`);
  }

  const rawProjects = raw['projects'];
  if (!Array.isArray(rawProjects)) {
    return singleErr('TOKENS_FILE_INVALID', `${loc('projects')} must be an array`);
  }
  const projects: ProjectCap[] = [];
  for (let j = 0; j < rawProjects.length; j++) {
    const entry = rawProjects[j];
    if (typeof entry !== 'object' || entry === null) {
      return singleErr('TOKENS_FILE_INVALID', `${loc(`projects[${j}]`)} must be a mapping`);
    }
    const e = entry as Record<string, unknown>;
    const pname = e['name'];
    if (typeof pname !== 'string') {
      return singleErr('TOKENS_FILE_INVALID', `${loc(`projects[${j}].name`)} must be a string`);
    }
    const cap: ProjectCap = { name: pname };
    const pRole = e['role'];
    if (pRole !== undefined) {
      if (typeof pRole !== 'string' || !['reader', 'writer', 'admin'].includes(pRole)) {
        return singleErr('TOKENS_FILE_INVALID',
          `${loc(`projects[${j}].role`)} must be reader|writer|admin if present`);
      }
      cap.role = pRole as 'reader' | 'writer' | 'admin';
    }
    projects.push(cap);
  }

  const record: TokenRecord = {
    id: toTokenId(id.value!),
    hash: toTokenHash(hash.value!),
    role: roleRaw.value! as TokenRecord['role'],
    projects,
    createdAt: createdAt.value!,
  };
  if (name.value !== undefined) record.name = name.value;
  if (agentId.value !== undefined) record.agentId = agentId.value;
  if (userId.value !== undefined) record.userId = userId.value;
  if (expiresAt.value !== undefined) record.expiresAt = expiresAt.value;
  if (revokedAt.value !== undefined) record.revokedAt = revokedAt.value;
  return ok(record);
}

function normalizeRecord(r: TokenRecord): TokenRecord {
  // Defensive copy of projects so mutations on returned records don't
  // bleed into the in-memory index.
  return { ...r, projects: r.projects.map(p => ({ ...p })) };
}

function serializeRecord(r: TokenRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: r.id,
    hash: r.hash,
    role: r.role,
    projects: r.projects.map(p => p.role !== undefined ? { name: p.name, role: p.role } : { name: p.name }),
    created_at: r.createdAt,
  };
  if (r.name !== undefined) out['name'] = r.name;
  if (r.agentId !== undefined) out['agent_id'] = r.agentId;
  if (r.userId !== undefined) out['user_id'] = r.userId;
  if (r.expiresAt !== undefined) out['expires_at'] = r.expiresAt;
  if (r.revokedAt !== undefined) out['revoked_at'] = r.revokedAt;
  return out;
}

function isActive(r: TokenRecord, now: Date): boolean {
  if (r.revokedAt !== undefined) return false;
  if (r.expiresAt !== undefined && new Date(r.expiresAt).getTime() < now.getTime()) return false;
  return true;
}
