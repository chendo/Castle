// Small in-browser cache of HA entity state. Subscribes once to the agent's
// state-snapshot + state-change frames and forwards updates to per-entity
// listeners. Centralises what was previously a single-handler pattern on the
// agent (onStatesSnapshot / onStateChange) so multiple consumers — sidebar,
// entity cards rendered by ha_present_card, future widgets — can react
// to the same stream without clobbering each other.

import type { EntityState, EntityStateChange, WebSocketRemoteAgent } from "./WebSocketRemoteAgent";

type AnyListener = (states: EntityState[]) => void;
type EntityListener = (s: EntityState | null) => void;

export class EntityStateCache {
  private states = new Map<string, EntityState>();
  private allListeners = new Set<AnyListener>();
  private perEntity = new Map<string, Set<EntityListener>>();

  /** Wire the cache to the agent's WS frames. Replaces whatever single
   *  handler was previously assigned to onStatesSnapshot / onStateChange,
   *  so call this once at app boot. */
  attachToAgent(agent: WebSocketRemoteAgent): void {
    agent.onStatesSnapshot = (states) => this.replaceAll(states);
    agent.onStateChange = (change) => this.applyChange(change);
  }

  get(entityId: string): EntityState | undefined {
    return this.states.get(entityId);
  }

  all(): EntityState[] {
    return [...this.states.values()];
  }

  /** Subscribe to bulk updates — fired with the full list whenever a
   *  snapshot replaces the cache. Returns an unsubscribe function. */
  subscribeAll(fn: AnyListener): () => void {
    this.allListeners.add(fn);
    // Initial fire so the caller doesn't have to handle the empty-cache
    // case as a special path.
    fn(this.all());
    return () => { this.allListeners.delete(fn); };
  }

  /** Subscribe to one entity's state. Fires immediately with current
   *  state (or null if unknown) and on every subsequent change. */
  subscribeEntity(entityId: string, fn: EntityListener): () => void {
    let bucket = this.perEntity.get(entityId);
    if (!bucket) {
      bucket = new Set();
      this.perEntity.set(entityId, bucket);
    }
    bucket.add(fn);
    fn(this.states.get(entityId) ?? null);
    return () => {
      const b = this.perEntity.get(entityId);
      if (!b) return;
      b.delete(fn);
      if (b.size === 0) this.perEntity.delete(entityId);
    };
  }

  private replaceAll(states: EntityState[]): void {
    this.states.clear();
    for (const s of states) this.states.set(s.entity_id, s);
    this.notifyAll();
    // Per-entity subscribers each get one update with their entity's
    // current value (or null if it disappeared).
    for (const [id, bucket] of this.perEntity) {
      const cur = this.states.get(id) ?? null;
      for (const fn of bucket) fn(cur);
    }
  }

  private applyChange(change: EntityStateChange): void {
    if ("removed" in change && change.removed) {
      this.states.delete(change.entity_id);
      this.notifyAll();
      const bucket = this.perEntity.get(change.entity_id);
      if (bucket) for (const fn of bucket) fn(null);
      return;
    }
    const next = change as EntityState;
    this.states.set(next.entity_id, next);
    this.notifyAll();
    const bucket = this.perEntity.get(next.entity_id);
    if (bucket) for (const fn of bucket) fn(next);
  }

  private notifyAll(): void {
    if (this.allListeners.size === 0) return;
    const snap = this.all();
    for (const fn of this.allListeners) fn(snap);
  }
}

/** Process-wide singleton. main.ts attaches it to the agent at boot;
 *  every other module imports it. */
export const entityCache = new EntityStateCache();
