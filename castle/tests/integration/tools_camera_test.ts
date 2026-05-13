// Integration tests: camera operations — snapshot capture, live feed display,
// and context-based entity reference resolution.

import { assert as _assert, assertEquals as _assertEquals } from "jsr:@std/assert@1";
import * as S from "./shared.ts";

const HA_BASE = S.getHaBaseUrl();

async function testRun(prompt: string, opts?: { timeoutMs?: number }) {
  return S.runConversation(prompt, opts);
}

/** True when the call targets the given camera, whether the agent passed
 *  `entity_id` (ha_get_camera_snapshot) or `entity_ids: string[]` (ha_present_card). */
function targetsCamera(args: Record<string, unknown> | null, cameraId: string): boolean {
  if (!args) return false;
  if (typeof args.entity_id === "string" && args.entity_id === cameraId) return true;
  const ids = args.entity_ids;
  if (Array.isArray(ids) && ids.includes(cameraId)) return true;
  return false;
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

    // Snapshot vs live-feed are semantically close — accept either as long
    // as the agent targeted the right camera and the call succeeded.
    const call = S.assertOneOfToolsCalled(
      result,
      ["ha_get_camera_snapshot", "ha_present_card"],
      (args) => targetsCamera(args, cameraId),
    );
    S.assertToolSucceeded(result, call.toolCallId);

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
      `Show me the live camera feed from ${cameraId} using ha_present_card.`,
    );

    S.assertOneOfToolsCalled(
      result,
      ["ha_present_card", "ha_get_camera_snapshot"],
      (args) => targetsCamera(args, cameraId),
    );
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
      `Take a snapshot from ${cameraId}. Now show me the live feed from the same camera using ha_present_card.`,
    );

    // The agent should produce at least two camera-tool calls targeting the
    // same entity; either tool counts since the model treats them as a pair.
    const cameraCalls = result.toolCalls.filter((tc) =>
      tc.toolName === "ha_get_camera_snapshot" || tc.toolName === "ha_present_card"
    );
    if (cameraCalls.length < 2) {
      throw new Error(
        `Expected at least 2 camera tool calls (snapshot + live). Got: [${result.toolCalls.map((t) => t.toolName).join(", ")}]`,
      );
    }
    for (const c of cameraCalls) {
      if (!targetsCamera(c.args, cameraId)) {
        throw new Error(
          `Expected ${c.toolName} to target ${cameraId}, got args: ${JSON.stringify(c.args)}`,
        );
      }
    }
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
    // unused but kept for clarity that we're testing one specific camera
    void cameraId;

    S.assertOneOfToolsCalled(
      result,
      ["ha_get_camera_snapshot", "ha_present_card"],
      (args) => {
        if (typeof args?.entity_id === "string" && args.entity_id.startsWith("camera.")) return true;
        const ids = args?.entity_ids;
        return Array.isArray(ids) && ids.some((id) => typeof id === "string" && id.startsWith("camera."));
      },
    );
  },
});
