// Per-resource version history for Castle-mediated edits to HA configuration
// (automations, dashboards). Persisted as one JSONL file per resource id under
// <DATA_DIR>/resource-history/<kind>/<id>.jsonl.
//
// Design choices:
//   - JSONL: append-only writes, crash-safe, trivial to inspect with `cat`.
//   - Full config in every record (not diffs): rollback is a one-shot read;
//     HA automation configs are tiny, dashboards modest. Storage cost is the
//     price for code simplicity.
//   - Per-id async lock around append: prevents two concurrent records from
//     racing on the version counter (unlikely in practice — the agent's tool
//     loop is serial — but cheap insurance).
//   - Retention enforced lazily after append. Trim path is rare so we
//     tolerate the rewrite cost when it fires.
//
// `source` distinguishes ordinary Castle writes from rollback writes so the
// UI can pill them differently and so a rollback chain can be traced via
// `parent_version`.

import { DATA_DIR } from "./paths.ts";

export type HistorySource = "castle" | "rollback";

export interface HistoryRecord {
  version: number;
  ts: string;
  kind: string;
  id: string;
  alias_at_save?: string;
  hash: string;
  config: unknown;
  source: HistorySource;
  parent_version?: number;
}

export type HistoryMeta = Omit<HistoryRecord, "config">;

export interface RecordInput {
  alias_at_save?: string;
  config: unknown;
  source: HistorySource;
  parent_version?: number;
}

const HISTORY_ROOT = `${DATA_DIR}/resource-history`;

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Canonical JSON serialization with sorted object keys. Two configs that
 * differ only in key order produce the same canonical string (and therefore
 * the same hash), which is what we want for "did anything actually change?"
 * comparisons. Arrays preserve order — order is semantic in HA configs.
 */
function canonicalize(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

export class ResourceHistoryStore {
  private locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly kind: string,
    private readonly maxVersions: number,
    private readonly root: string = HISTORY_ROOT,
  ) {}

  private path(id: string): string {
    // encodeURIComponent guards against ids containing slashes or other
    // path-significant characters. HA's automation_id is numeric in practice,
    // but dashboards use url_path which can be arbitrary.
    return `${this.root}/${this.kind}/${encodeURIComponent(id)}.jsonl`;
  }

  private async ensureDir(): Promise<void> {
    await Deno.mkdir(`${this.root}/${this.kind}`, { recursive: true });
  }

  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = (this.locks.get(id) ?? Promise.resolve()) as Promise<unknown>;
    // `.then(fn, fn)` ensures we run regardless of whether prev resolved or
    // rejected; we're a lock, not an error propagator.
    const next = prev.then(fn, fn) as Promise<T>;
    this.locks.set(id, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(id) === next) this.locks.delete(id);
    }
  }

  /**
   * Append a new version. Returns the persisted record. The `hash` field is
   * derived from a canonicalized JSON form of `config`, so callers can
   * compare against a known hash to skip no-op records if desired.
   */
  async record(id: string, input: RecordInput): Promise<HistoryRecord> {
    return await this.withLock(id, async () => {
      await this.ensureDir();
      const existing = await this.readAll(id);
      const lastVersion = existing[existing.length - 1]?.version ?? 0;
      const hash = "sha256:" + (await sha256Hex(canonicalize(input.config)));
      const rec: HistoryRecord = {
        version: lastVersion + 1,
        ts: new Date().toISOString(),
        kind: this.kind,
        id,
        ...(input.alias_at_save ? { alias_at_save: input.alias_at_save } : {}),
        hash,
        config: input.config,
        source: input.source,
        ...(input.parent_version !== undefined ? { parent_version: input.parent_version } : {}),
      };
      await Deno.writeTextFile(this.path(id), JSON.stringify(rec) + "\n", { append: true });
      if (this.maxVersions > 0 && existing.length + 1 > this.maxVersions) {
        await this.trim(id);
      }
      return rec;
    });
  }

  /** Meta only (no config body) for all recorded versions, oldest-first. */
  async list(id: string): Promise<HistoryMeta[]> {
    return (await this.readAll(id)).map((r) => {
      const { config: _, ...meta } = r;
      return meta;
    });
  }

  /** Full record by version. Returns null if not found. */
  async get(id: string, version: number): Promise<HistoryRecord | null> {
    const all = await this.readAll(id);
    return all.find((r) => r.version === version) ?? null;
  }

  /** Hash of the most recent record, or null if no history yet. */
  async lastHash(id: string): Promise<string | null> {
    const all = await this.readAll(id);
    return all[all.length - 1]?.hash ?? null;
  }

  /** Compute the hash a config would get if recorded — for caller-side dedup. */
  static async hashOf(config: unknown): Promise<string> {
    return "sha256:" + (await sha256Hex(canonicalize(config)));
  }

  private async readAll(id: string): Promise<HistoryRecord[]> {
    let text: string;
    try {
      text = await Deno.readTextFile(this.path(id));
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return [];
      throw err;
    }
    const out: HistoryRecord[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as HistoryRecord);
      } catch {
        // Skip a corrupt line; the rest of the file is still readable. Better
        // than failing the whole list when one record got truncated by a
        // mid-write crash on an older runtime.
      }
    }
    return out;
  }

  private async trim(id: string): Promise<void> {
    const all = await this.readAll(id);
    if (all.length <= this.maxVersions) return;
    const keep = all.slice(all.length - this.maxVersions);
    const text = keep.map((r) => JSON.stringify(r)).join("\n") + "\n";
    // Atomic replace via tmp + rename so a crash mid-trim can't half-truncate.
    const final = this.path(id);
    const tmp = `${final}.tmp`;
    await Deno.writeTextFile(tmp, text);
    await Deno.rename(tmp, final);
  }
}

/**
 * Unified-style diff between two JSON-serializable configs. Lines are
 * prefixed with ` `, `-`, or `+`. Configs are pretty-printed with 2-space
 * indentation before diffing — sufficient for chat output, not trying to
 * match `diff -u` byte for byte.
 */
export function diffConfigs(from: unknown, to: unknown): string {
  const a = JSON.stringify(from, null, 2).split("\n");
  const b = JSON.stringify(to, null, 2).split("\n");
  return unifiedDiff(a, b);
}

function unifiedDiff(a: string[], b: string[]): string {
  // LCS via DP. Configs are small (typically < 1000 lines) so O(n·m) memory
  // is fine. If we ever diff something huge, switch to Myers.
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push(" " + a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push("-" + a[i]);
      i++;
    } else {
      lines.push("+" + b[j]);
      j++;
    }
  }
  while (i < n) lines.push("-" + a[i++]);
  while (j < m) lines.push("+" + b[j++]);
  return lines.join("\n");
}
