import type { RecentEntityWire, WebSocketRemoteAgent } from "./WebSocketRemoteAgent";

class RecentEntitiesStore {
  private list: RecentEntityWire[] = [];
  private listeners = new Set<(snapshot: RecentEntityWire[]) => void>();
  private wired = false;

  attachToAgent(agent: WebSocketRemoteAgent): void {
    if (this.wired) return;
    this.wired = true;
    agent.onRecentEntitiesSnapshot = (entities) => {
      this.list = entities;
      this.notify();
    };
  }

  snapshot(): RecentEntityWire[] {
    return this.list.slice();
  }

  subscribe(fn: (snapshot: RecentEntityWire[]) => void): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => { this.listeners.delete(fn); };
  }

  private notify(): void {
    const snap = this.snapshot();
    for (const fn of this.listeners) {
      try { fn(snap); } catch (err) { console.error("[recent] listener:", err); }
    }
  }
}

export const recentEntitiesStore = new RecentEntitiesStore();
