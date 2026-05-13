// Global LRU of entities the agent has touched. Survives session resets so
// the Now feed has continuity across conversations — the goal is to preserve
// "what's been on the radar lately" as soft context for a more intelligent
// assistant.
//
// Wire-in: main.ts walks every agent event for entity_id-shaped strings and
// calls push() / pushMany(). Persistence is .pi-agent/recent-entities.json,
// debounced so a burst of tool calls doesn't fsync per call.

const AGENT_DIR = new URL(".pi-agent/", import.meta.url).pathname.replace(/\/$/, "");
const FILE = `${AGENT_DIR}/recent-entities.json`;

const MAX = 30;
const PERSIST_DEBOUNCE_MS = 1_000;
const ENTITY_ID_RE = /^[a-z_][a-z0-9_]*\.[a-z0-9_]+$/i;

export interface RecentEntity {
  entity_id: string;
  /** Last-touched wall-clock ms. */
  ts: number;
}

export class RecentEntitiesManager {
  private items: RecentEntity[] = [];
  private listeners = new Set<(snapshot: RecentEntity[]) => void>();
  private persistTimer: number | undefined;
  private booted = false;

  async init(): Promise<void> {
    if (this.booted) return;
    this.booted = true;
    try {
      const text = await Deno.readTextFile(FILE);
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        this.items = parsed
          .filter((e): e is RecentEntity =>
            typeof e === "object" && e !== null
            && typeof (e as RecentEntity).entity_id === "string"
            && ENTITY_ID_RE.test((e as RecentEntity).entity_id)
            && typeof (e as RecentEntity).ts === "number"
          )
          .slice(0, MAX);
      }
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) {
        console.warn(`[recent] failed to read ${FILE}:`, (err as Error).message);
      }
    }
  }

  /** Push one entity to the front. Idempotent for already-present ids
   *  (moves to front + bumps ts). Notifies listeners and schedules persist. */
  push(entityId: string): void {
    if (typeof entityId !== "string" || !ENTITY_ID_RE.test(entityId)) return;
    const now = Date.now();
    const existingIdx = this.items.findIndex((e) => e.entity_id === entityId);
    if (existingIdx >= 0) {
      const [existing] = this.items.splice(existingIdx, 1);
      existing.ts = now;
      this.items.unshift(existing);
    } else {
      this.items.unshift({ entity_id: entityId, ts: now });
      if (this.items.length > MAX) this.items.length = MAX;
    }
    this.notify();
    this.schedulePersist();
  }

  /** Bulk push — preserves order, deduplicates against the existing list. */
  pushMany(entityIds: string[]): void {
    let mutated = false;
    const now = Date.now();
    // Walk in reverse so the original first id ends up frontmost.
    for (let i = entityIds.length - 1; i >= 0; i--) {
      const id = entityIds[i];
      if (typeof id !== "string" || !ENTITY_ID_RE.test(id)) continue;
      const existingIdx = this.items.findIndex((e) => e.entity_id === id);
      if (existingIdx >= 0) {
        const [existing] = this.items.splice(existingIdx, 1);
        existing.ts = now;
        this.items.unshift(existing);
      } else {
        this.items.unshift({ entity_id: id, ts: now });
      }
      mutated = true;
    }
    if (this.items.length > MAX) this.items.length = MAX;
    if (mutated) {
      this.notify();
      this.schedulePersist();
    }
  }

  snapshot(): RecentEntity[] {
    return this.items.slice();
  }

  /** Drop everything. Returns true if anything was removed. */
  clear(): boolean {
    if (this.items.length === 0) return false;
    this.items = [];
    this.notify();
    this.schedulePersist();
    return true;
  }

  subscribe(fn: (snapshot: RecentEntity[]) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private notify(): void {
    const snap = this.snapshot();
    for (const fn of this.listeners) {
      try { fn(snap); }
      catch (err) { console.warn("[recent] listener threw:", (err as Error).message); }
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer !== undefined) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persist();
    }, PERSIST_DEBOUNCE_MS);
  }

  private async persist(): Promise<void> {
    try {
      await Deno.writeTextFile(FILE, JSON.stringify(this.items, null, 2));
    } catch (err) {
      console.warn("[recent] persist failed:", (err as Error).message);
    }
  }
}

/**
 * Walk an arbitrary value looking for strings that match the HA entity_id
 * shape (`domain.id`). Used to lift entity references out of agent tool
 * arguments without each tool announcing its own entity-id field.
 */
export function extractEntityIds(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (ENTITY_ID_RE.test(value)) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) extractEntityIds(v, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) extractEntityIds(v, out);
  }
  return out;
}

let singleton: RecentEntitiesManager | null = null;
export function setRecentEntitiesSingleton(m: RecentEntitiesManager): void {
  singleton = m;
}
export function getRecentEntitiesSingleton(): RecentEntitiesManager | null {
  return singleton;
}
