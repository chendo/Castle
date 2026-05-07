import type { TaskWire, WebSocketRemoteAgent } from "./WebSocketRemoteAgent";

/**
 * Local mirror of the server's task registry. Topbar chip + dialog both
 * subscribe here so they share a single stream of WS task events.
 *
 * Wired once from main.ts via attachToAgent(); subsequent calls are no-ops.
 */
class TasksStore {
  private tasks = new Map<string, TaskWire>();
  private listeners = new Set<(snapshot: TaskWire[]) => void>();
  private wired = false;

  attachToAgent(agent: WebSocketRemoteAgent): void {
    if (this.wired) return;
    this.wired = true;
    agent.onTasksSnapshot = (list) => {
      this.tasks.clear();
      for (const t of list) this.tasks.set(t.id, t);
      this.notify();
    };
    agent.onTaskEvent = (event) => {
      if (event.type === "task_deleted") {
        this.tasks.delete(event.id);
      } else {
        this.tasks.set(event.task.id, event.task);
      }
      this.notify();
    };
  }

  list(): TaskWire[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  activeCount(): number {
    let n = 0;
    for (const t of this.tasks.values()) if (t.status === "watching") n++;
    return n;
  }

  subscribe(fn: (snapshot: TaskWire[]) => void): () => void {
    this.listeners.add(fn);
    fn(this.list());
    return () => { this.listeners.delete(fn); };
  }

  private notify(): void {
    const snap = this.list();
    for (const l of this.listeners) {
      try { l(snap); } catch (err) { console.error("[tasks] listener:", err); }
    }
  }
}

export const tasksStore = new TasksStore();
