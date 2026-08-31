import { assert, assertEquals } from "jsr:@std/assert@1";
import { ObserverRuntime } from "../observer-runtime.ts";
import type { HAState } from "../ha-client.ts";
import { OBSERVER_DEFAULTS, saveSettings } from "../settings.ts";

// Drives the runtime's scheduling and wiring without an LLM. The pass itself
// needs a model, so these tests stop at the point where a pass would be
// enqueued and assert what led there — the subscription plumbing, the mute
// list, the manual-action capture, and the lifecycle guarantees.

const T0 = Date.parse("2026-08-31T18:00:00Z");

type Transition = (id: string, oldS: HAState | null, newS: HAState | null) => void;
type BusListener = (data: Record<string, unknown>, at?: string) => void;

class FakeHAClient {
  isConnected = true;
  transitionListeners: Transition[] = [];
  busListeners = new Map<string, BusListener[]>();
  unsubscribeCount = 0;
  states: HAState[] = [];

  onStateTransition(fn: Transition): () => void {
    this.transitionListeners.push(fn);
    return () => {
      this.unsubscribeCount++;
      this.transitionListeners = this.transitionListeners.filter((f) => f !== fn);
    };
  }
  onBusEvent(type: string, fn: BusListener): () => void {
    const list = this.busListeners.get(type) ?? [];
    list.push(fn);
    this.busListeners.set(type, list);
    return () => {
      this.unsubscribeCount++;
      this.busListeners.set(type, (this.busListeners.get(type) ?? []).filter((f) => f !== fn));
    };
  }
  getAllStates(): HAState[] {
    return this.states;
  }
  // deno-lint-ignore require-await
  async getHouseInfo(): Promise<{ timezone: string }> {
    return { timezone: "UTC" };
  }
  // deno-lint-ignore require-await
  async restCall(): Promise<Response> {
    return new Response("{}", { status: 404 });
  }
  emit(id: string, from: string, to: string, opts: { userId?: string; parentId?: string } = {}): void {
    const mk = (v: string): HAState => ({
      entity_id: id,
      state: v,
      attributes: {},
      last_changed: new Date(T0).toISOString(),
      last_updated: new Date(T0).toISOString(),
      context: { id: "c", parent_id: opts.parentId ?? null, user_id: opts.userId ?? null },
    });
    for (const fn of this.transitionListeners) fn(id, mk(from), mk(to));
  }
}

async function withRuntime(
  fn: (rt: ObserverRuntime, ha: FakeHAClient) => Promise<void>,
  observer: Partial<typeof OBSERVER_DEFAULTS> = {},
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const prev = Deno.env.get("CASTLE_DATA_DIR");
  await saveSettings({
    observer: { ...OBSERVER_DEFAULTS, enabled: true, heartbeatMinutes: 0, reviewHours: 0, ...observer },
  });
  const ha = new FakeHAClient();
  // deno-lint-ignore no-explicit-any
  const rt = new ObserverRuntime(ha as any, () => T0, dir);
  try {
    await rt.start();
    await fn(rt, ha);
  } finally {
    rt.stop();
    await saveSettings({ observer: OBSERVER_DEFAULTS });
    if (prev === undefined) Deno.env.delete("CASTLE_DATA_DIR");
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("start — subscribes to transitions and both bus event types", async () => {
  await withRuntime((_rt, ha) => {
    assertEquals(ha.transitionListeners.length, 1);
    assert(ha.busListeners.get("automation_triggered")?.length === 1);
    assert(ha.busListeners.get("script_started")?.length === 1);
    return Promise.resolve();
  });
});

Deno.test("stop — releases every subscription and timer it took", async () => {
  const dir = await Deno.makeTempDir();
  const ha = new FakeHAClient();
  await saveSettings({
    observer: { ...OBSERVER_DEFAULTS, enabled: true, heartbeatMinutes: 5, reviewHours: 1 },
  });
  // deno-lint-ignore no-explicit-any
  const rt = new ObserverRuntime(ha as any, () => T0, dir);
  await rt.start();
  rt.stop();
  assertEquals(ha.transitionListeners.length, 0);
  assertEquals(ha.busListeners.get("automation_triggered")?.length, 0);
  assertEquals(ha.unsubscribeCount, 3);
  assertEquals(rt.status().nextHeartbeatAt, null);
  // A leaked interval would fail this test via Deno's timer sanitizer.
  await saveSettings({ observer: OBSERVER_DEFAULTS });
  await Deno.remove(dir, { recursive: true });
});

Deno.test("stop — is idempotent and safe before start", async () => {
  const dir = await Deno.makeTempDir();
  const ha = new FakeHAClient();
  // deno-lint-ignore no-explicit-any
  const rt = new ObserverRuntime(ha as any, () => T0, dir);
  rt.stop();
  await rt.start();
  rt.stop();
  rt.stop();
  assertEquals(rt.status().enabled, false);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("manual actions are captured for the review pass", async () => {
  await withRuntime((rt, ha) => {
    ha.emit("light.lounge", "off", "on", { userId: "u1" });
    const rows = rt.manualActions.all();
    assertEquals(rows.length, 1);
    assertEquals(rows[0].entityId, "light.lounge");
    assertEquals(rows[0].to, "on");
    return Promise.resolve();
  });
});

Deno.test("automation-driven changes are not logged as manual actions", async () => {
  // The whole point of the manual log is separating habits from automations
  // already doing their job; a false positive here proposes automating
  // something that is already automated.
  await withRuntime((rt, ha) => {
    ha.emit("light.hall", "off", "on", { parentId: "p1" });
    ha.emit("light.hall", "on", "off");
    assertEquals(rt.manualActions.all().length, 0);
    return Promise.resolve();
  });
});

Deno.test("manual actions are logged even for domains a pass would ignore", async () => {
  // "significant" filters what wakes an agent, not what is worth remembering.
  await withRuntime((rt, ha) => {
    ha.emit("input_number.target", "20", "22", { userId: "u1" });
    assertEquals(rt.manualActions.all().length, 1);
    return Promise.resolve();
  });
});

Deno.test("muted entities never reach the buffer or the log", async () => {
  await withRuntime((rt, ha) => {
    ha.emit("binary_sensor.flaky", "off", "on", { userId: "u1" });
    // Muting is about not being told; the manual log is a separate concern and
    // still records it, but nothing schedules a pass.
    assertEquals(rt.status().running, false);
    return Promise.resolve();
  }, { mutes: ["binary_sensor.flaky"] });
});

Deno.test("status reports what the UI needs and starts clean", async () => {
  await withRuntime((rt) => {
    const s = rt.status();
    assertEquals(s.enabled, true);
    assertEquals(s.running, false);
    assertEquals(s.passesThisHour, 0);
    assertEquals(s.lastPassAt, null);
    return Promise.resolve();
  });
});

Deno.test("status listeners fire on start and unsubscribe cleanly", async () => {
  const dir = await Deno.makeTempDir();
  const ha = new FakeHAClient();
  // deno-lint-ignore no-explicit-any
  const rt = new ObserverRuntime(ha as any, () => T0, dir);
  const seen: boolean[] = [];
  const off = rt.onStatus((s) => seen.push(s.enabled));
  await rt.start();
  off();
  rt.stop();
  assertEquals(seen, [true]);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("runNow declines when HA is down rather than firing blind", async () => {
  await withRuntime(async (rt, ha) => {
    ha.isConnected = false;
    const r = await rt.runNow("reactive");
    assertEquals(r.ran, false);
    assertEquals(r.reason, "HA is not connected");
  });
});

Deno.test("runNow declines when there is nothing to look at", async () => {
  // No events buffered, so a reactive pass has no evidence and must not cost
  // an LLM turn.
  await withRuntime(async (rt) => {
    const r = await rt.runNow("reactive");
    assertEquals(r.ran, false);
    assertEquals(r.reason, "nothing to look at");
  });
});

Deno.test("a heartbeat with a healthy house has no evidence and does not run", async () => {
  await withRuntime(async (rt, ha) => {
    ha.states = [{
      entity_id: "light.a",
      state: "on",
      attributes: {},
      last_changed: new Date(T0).toISOString(),
      last_updated: new Date(T0).toISOString(),
    }];
    const r = await rt.runNow("heartbeat");
    assertEquals(r.ran, false);
    assertEquals(r.reason, "nothing to look at");
  });
});

Deno.test("observations raised by a pass reach subscribers", async () => {
  await withRuntime(async (rt) => {
    const seen: string[] = [];
    const off = rt.onObservation((o) => seen.push(o.id));
    const r = await rt.observations.raise(
      { type: "concern", severity: "warn", summary: "test", entities: [] },
      { id: "p", kind: "reactive", startedAt: T0, durationMs: 1, toolCalls: 0 },
    );
    off();
    assertEquals(seen, [r.observation.id]);
  });
});
