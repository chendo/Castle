import { assertEquals } from "jsr:@std/assert@1";
import { loadSettings, OBSERVER_DEFAULTS, saveSettings } from "../settings.ts";

// settings.ts caches module-level and writes to DATA_DIR, so these tests drive
// it through its public API in one sequence rather than isolating each case.
// The point under test is sanitize(), which is pure with respect to that cache.

Deno.test("observer settings — a fresh install is off by default", async () => {
  const s = await loadSettings();
  assertEquals(s.observer.enabled, false);
  assertEquals(s.observer.cameras, [], "vision must be opt-in");
});

Deno.test("observer settings — a missing block yields the whole default", async () => {
  const s = await saveSettings({ observer: undefined as never });
  assertEquals(s.observer, OBSERVER_DEFAULTS);
});

Deno.test("observer settings — a garbage block yields the whole default", async () => {
  const s = await saveSettings({ observer: "not an object" as never });
  assertEquals(s.observer, OBSERVER_DEFAULTS);
});

Deno.test("observer settings — cadences clamp rather than reject", async () => {
  const s = await saveSettings({
    observer: { ...OBSERVER_DEFAULTS, heartbeatMinutes: 1, reviewHours: 9999, maxPassesPerHour: 500 },
  });
  assertEquals(s.observer.heartbeatMinutes, 5);
  assertEquals(s.observer.reviewHours, 168);
  assertEquals(s.observer.maxPassesPerHour, 30);
});

Deno.test("observer settings — zero disables a cadence instead of clamping up", async () => {
  const s = await saveSettings({
    observer: { ...OBSERVER_DEFAULTS, heartbeatMinutes: 0, reviewHours: 0 },
  });
  assertEquals(s.observer.heartbeatMinutes, 0);
  assertEquals(s.observer.reviewHours, 0);
});

Deno.test("observer settings — context window has a floor", async () => {
  const s = await saveSettings({ observer: { ...OBSERVER_DEFAULTS, contextWindow: 100 } });
  assertEquals(s.observer.contextWindow, 16384);
});

Deno.test("observer settings — mutes keep only well-formed entity ids", async () => {
  const s = await saveSettings({
    observer: {
      ...OBSERVER_DEFAULTS,
      mutes: ["binary_sensor.flaky", "not an id", "", "light.a", "light.a", 42 as never],
    },
  });
  assertEquals(s.observer.mutes, ["binary_sensor.flaky", "light.a"]);
});

Deno.test("observer settings — the camera allowlist rejects non-cameras", async () => {
  // This list is the entire privacy boundary for vision, so a stray
  // non-camera entity must not survive into it.
  const s = await saveSettings({
    observer: { ...OBSERVER_DEFAULTS, cameras: ["camera.front", "light.porch", "sensor.x"] },
  });
  assertEquals(s.observer.cameras, ["camera.front"]);
});

Deno.test("observer settings — scope flags default on and survive a partial object", async () => {
  const s = await saveSettings({
    observer: { ...OBSERVER_DEFAULTS, scope: { suggestions: false } as never },
  });
  assertEquals(s.observer.scope, {
    automationHealth: true,
    deviceHealth: true,
    suggestions: false,
    automationGaps: true,
  });
});

Deno.test("observer settings — enabling persists through a save/load round trip", async () => {
  await saveSettings({ observer: { ...OBSERVER_DEFAULTS, enabled: true, cameras: ["camera.front"] } });
  const s = await loadSettings();
  assertEquals(s.observer.enabled, true);
  assertEquals(s.observer.cameras, ["camera.front"]);
  // Leave the store as we found it for any later test in the same process.
  await saveSettings({ observer: OBSERVER_DEFAULTS });
});
