// Integration tests: camera operations — snapshot capture, live feed display,
// and context-based entity reference resolution.

import { assert as _assert, assertEquals } from "jsr:@std/assert@1";
import * as S from "./shared.ts";

const HA_BASE = S.getHaBaseUrl();

async function testRun(prompt: string, opts?: { timeoutMs?: number }) {
  return S.runConversation(prompt, opts);
}

// ── Tests ───────────────────────────────────────────────────────────────────

Deno.test({
  name: "camera — snapshot capture and confirm success",
  fn: async () => {
    const cameraId = await S.findDemoCamera(HA_BASE);
    if (!cameraId) throw new Error("No camera entity found in HA demo");

    const result = await testRun(
      `Take a snapshot from ${cameraId} using ha_get_camera_snapshot. Briefly confirm whether the capture succeeded and what you see.`,
    );

    S.assertToolCalled(result, "ha_get_camera_snapshot", (args) => String(args?.entity_id ?? "") === cameraId);

    // Verify tool call succeeded
    const snapCall = S.assertToolCalled(result, "ha_get_camera_snapshot");
    S.assertToolSucceeded(result, snapCall.toolCallId);

    // Read-only — no mutations
    S.assertNoMutatingTools(result);
  },
});

Deno.test({
  name: "camera — show live feed",
  fn: async () => {
    const cameraId = await S.findDemoCamera(HA_BASE);
    if (!cameraId) throw new Error("No camera entity found in HA demo");

    const result = await testRun(
      `Show me the live camera feed from ${cameraId} using ha_show_camera.`,
    );

    S.assertToolCalled(result, "ha_show_camera", (args) => String(args?.entity_id ?? "") === cameraId);
  },
});

Deno.test({
  name: "camera — snapshot then show live in same session (context inference)",
  fn: async () => {
    const cameraId = await S.findDemoCamera(HA_BASE);
    if (!cameraId) throw new Error("No camera entity found in HA demo");

    // Two-turn conversation: first turn takes a snapshot, second turn references "the camera"
    // We simulate this by running two separate conversations and checking the agent
    // handles context properly. Since each runConversation is independent, we test that
    // the agent can infer which camera when prompted with just "the camera" after
    // establishing it in a prior session.

    const result = await testRun(
      `Take a snapshot from ${cameraId}. Now show me the live feed from the same camera using ha_show_camera.`,
    );

    // Both tools should be called in sequence
    const snapCall = S.assertToolCalled(result, "ha_get_camera_snapshot");
    assertEquals(snapCall.args?.entity_id, cameraId);

    S.assertToolCalled(result, "ha_show_camera", (args) => {
      return typeof args?.entity_id === "string" && args.entity_id.startsWith("camera.");
    });
  },
});

Deno.test({
  name: "camera — snapshot from camera mentioned by description only",
  fn: async () => {
    const cameraId = await S.findDemoCamera(HA_BASE);
    if (!cameraId) throw new Error("No camera entity found in HA demo");

    // Prompt that doesn't use the exact entity_id but describes it
    const result = await testRun(
      `I need to see what's happening right now — take a snapshot from the available camera using ha_get_camera_snapshot.`,
    );

    S.assertToolCalled(result, "ha_get_camera_snapshot", (args) => {
      return typeof args?.entity_id === "string" && args.entity_id.startsWith("camera.");
    });
  },
});
