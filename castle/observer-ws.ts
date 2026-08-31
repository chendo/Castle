// WebSocket surface for the observer.
//
// Lives here rather than in main.ts, which is already past the 1000-line mark
// the repo's standards say to shrink rather than grow. main.ts delegates in
// three lines: one hello hook, one message hook, one broadcast wiring.

import type { ObserverRuntime, ObserverStatus } from "./observer-runtime.ts";
import type { Observation, ObservationStatus, PassKind } from "./observer-store.ts";
import { resetObserverContext } from "./observer-agent.ts";

let runtime: ObserverRuntime | null = null;

export function setObserverRuntime(r: ObserverRuntime): void {
  runtime = r;
}

/** Frames replayed to a client that has just connected. */
export function observerHelloFrames(): string[] {
  if (!runtime) return [];
  return [
    JSON.stringify({
      type: "observations_snapshot",
      observations: runtime.observations.snapshot(),
      status: runtime.status(),
    }),
  ];
}

export function observationFrame(observation: Observation): string {
  return JSON.stringify({ type: "observation", observation });
}

export function observerStatusFrame(status: ObserverStatus): string {
  return JSON.stringify({ type: "observer_status", status });
}

const STATUSES: ObservationStatus[] = ["open", "acknowledged", "dismissed", "resolved"];
const KINDS: PassKind[] = ["reactive", "heartbeat", "review"];

/**
 * Handle an observer-related client message. Returns true when the message was
 * ours, so main.ts's dispatch chain can fall through for everything else.
 */
export async function handleObserverMessage(
  socket: WebSocket,
  msg: { type?: string } & Record<string, unknown>,
): Promise<boolean> {
  if (!runtime) return false;

  if (msg.type === "set_observation_status") {
    const id = typeof msg.id === "string" ? msg.id : "";
    const status = msg.status as ObservationStatus;
    if (!id || !STATUSES.includes(status)) {
      socket.send(JSON.stringify({ type: "error", message: "set_observation_status: bad id or status" }));
      return true;
    }
    const reason = typeof msg.reason === "string" ? msg.reason : undefined;
    await runtime.observations.setStatus(id, status, reason);
    return true;
  }

  if (msg.type === "run_observer_pass") {
    const kind = KINDS.includes(msg.kind as PassKind) ? msg.kind as PassKind : "reactive";
    const result = await runtime.runNow(kind);
    socket.send(JSON.stringify({ type: "observer_pass_ack", ran: result.ran, reason: result.reason }));
    return true;
  }

  if (msg.type === "reset_observer_context") {
    await resetObserverContext();
    socket.send(JSON.stringify({ type: "observer_pass_ack", ran: false, reason: "context reset" }));
    return true;
  }

  if (msg.type === "forget_observer_memory") {
    await runtime.memory.clear();
    socket.send(JSON.stringify({ type: "observer_pass_ack", ran: false, reason: "memory cleared" }));
    return true;
  }

  return false;
}
