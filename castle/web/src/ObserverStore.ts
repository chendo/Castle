import type {
  ObservationWire,
  ObserverStatusWire,
  WebSocketRemoteAgent,
} from "./WebSocketRemoteAgent";

/**
 * Client-side mirror of the observer's findings, fed by the WS frames.
 * Same shape as RecentEntitiesStore: attach once, subscribe with immediate
 * replay so a late-mounting view paints straight away rather than waiting for
 * the next event.
 */
class ObserverStore {
  private byId = new Map<string, ObservationWire>();
  private state: ObserverStatusWire | null = null;
  private listeners = new Set<() => void>();
  private wired = false;

  attachToAgent(agent: WebSocketRemoteAgent): void {
    if (this.wired) return;
    this.wired = true;
    agent.onObservationsSnapshot = (observations, status) => {
      this.byId = new Map(observations.map((o) => [o.id, o]));
      this.state = status;
      this.notify();
    };
    // Creates and updates arrive on the same frame — an observation that
    // recurs bumps its occurrence count rather than making a new row, so the
    // client has to replace by id rather than prepend.
    agent.onObservation = (observation) => {
      this.byId.set(observation.id, observation);
      this.notify();
    };
    agent.onObserverStatus = (status) => {
      this.state = status;
      this.notify();
    };
  }

  /** Newest activity first. */
  all(): ObservationWire[] {
    return [...this.byId.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  open(): ObservationWire[] {
    return this.all().filter((o) => o.status === "open");
  }

  status(): ObserverStatusWire | null {
    return this.state;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    fn();
    return () => { this.listeners.delete(fn); };
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try { fn(); } catch (err) { console.error("[observer] listener:", err); }
    }
  }
}

export const observerStore = new ObserverStore();
