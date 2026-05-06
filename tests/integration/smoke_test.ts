// Smoke suite: one prompt per critical capability so we can sanity-check the
// stack (HA + LLM + WS protocol + tool wiring) in ~1 minute instead of ~9.
//
// What each test covers:
//   - read entity     → ha_get_entity / ha_get_states
//   - write service   → ha_call_service (mutation verified against HA)
//   - present card    → ha_present_card
//   - dashboard list  → ha_list_dashboards
//   - automation read → ha_get_automation
//
// If any of these flip red, the broader suite probably will too — start here.
// Run via: docker compose exec castle deno task test:smoke
//          (or `bash scripts/run-integration-tests.sh` with INTEGRATION_FILTER="smoke —")

import * as S from "./shared.ts";

const HA_BASE = S.getHaBaseUrl();

Deno.test({
  name: "smoke — read one entity's state via ha_get_entity / ha_get_states",
  fn: async () => {
    const lightId = await S.findDemoLight(HA_BASE);
    if (!lightId) throw new Error("No light entity found in HA demo");

    const result = await S.runConversation(
      `Get the current state of ${lightId}.`,
    );

    S.assertOneOfToolsCalled(
      result,
      ["ha_get_entity", "ha_get_states"],
      (args) => String(args?.entity_id ?? "") === lightId,
    );
    S.assertNoMutatingTools(result);
  },
});

Deno.test({
  name: "smoke — write via ha_call_service flips actual HA state",
  fn: async () => {
    const lightId = await S.findDemoLight(HA_BASE);
    if (!lightId) throw new Error("No light entity found in HA demo");

    // Start from a known state so the assertion is deterministic.
    await S.setEntityState(HA_BASE, lightId, "off");

    const result = await S.runConversation(
      `Turn on ${lightId} using ha_call_service. Confirm in one sentence.`,
    );

    S.assertToolCalled(result, "ha_call_service", (args) =>
      args?.domain === "light" &&
      String(args?.service ?? "") === "turn_on" &&
      String(args?.entity_id ?? "") === lightId,
    );
    // Polling read — HA processes the service call asynchronously.
    await S.waitForEntityState(HA_BASE, lightId, "on", 3_000);
  },
});

Deno.test({
  name: "smoke — present a camera card via ha_present_card",
  fn: async () => {
    const cameraId = await S.findDemoCamera(HA_BASE);
    if (!cameraId) throw new Error("No camera entity found in HA demo");

    const result = await S.runConversation(
      `Show me the live feed from ${cameraId}.`,
    );

    // ha_present_card is core; the agent should pick it directly. Accept
    // either the singular old shape (entity_id) or the new list shape
    // (entity_ids: [...]) so we're not pinned to a transient parameter
    // form during this consolidation.
    S.assertToolCalled(result, "ha_present_card", (args) => {
      const entity = String(args?.entity_id ?? "");
      const list = (args?.entity_ids as string[] | undefined) ?? [];
      return entity === cameraId || list.includes(cameraId);
    });
  },
});

Deno.test({
  name: "smoke — list dashboards via ha_list_dashboards",
  fn: async () => {
    const result = await S.runConversation(
      `List my Lovelace dashboards.`,
    );

    S.assertToolCalled(result, "ha_list_dashboards");
    S.assertNoMutatingTools(result);
  },
});

Deno.test({
  name: "smoke — read an automation's config via ha_get_automation",
  fn: async () => {
    const auto = await S.findDemoAutomation(HA_BASE);
    if (!auto) throw new Error("No automations found in HA demo");

    const result = await S.runConversation(
      `Show me the YAML for ${auto.entity_id}.`,
    );

    S.assertToolCalled(result, "ha_get_automation", (args) =>
      String(args?.automation_id ?? "") === String(auto.id)
    );
    S.assertNoMutatingTools(result);
  },
});
