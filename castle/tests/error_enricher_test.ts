import { assert, assertEquals } from "jsr:@std/assert";
import { enrichErrorText, enrichToolErrorMessage } from "../agent.ts";

const SCHEMAS = new Map<string, unknown>([
  [
    "ha_call_service",
    {
      type: "object",
      properties: {
        domain: { type: "string", description: "e.g. light, switch" },
        service: { type: "string", description: "e.g. turn_on" },
        entity_id: { type: "string", description: "Target entity" },
      },
      required: ["domain", "service"],
    },
  ],
]);
const ENABLED = ["ha_call_service", "ha_get_states", "ha_present_card"];

Deno.test("enrichErrorText — appends schema for validator failures", () => {
  const original =
    `Validation failed for tool "ha_call_service":\n  - /domain: Required field is missing\n\nReceived arguments:\n{}`;
  const next = enrichErrorText(original, SCHEMAS, ENABLED);
  assert(next.startsWith(original), "preserves the original failure prefix");
  assert(next.includes("Correct schema for ha_call_service:"), "names the tool");
  assert(next.includes('"domain"'), "embeds the schema body");
  assert(next.includes("required"), "shows required fields");
  assert(next.includes("Fix the arguments"), "tells the model to retry");
});

Deno.test("enrichErrorText — appends tool list for unknown-tool errors", () => {
  const original = `Tool "ha_make_coffee" not found`;
  const next = enrichErrorText(original, SCHEMAS, ENABLED);
  assert(next.includes("Available tools: ha_call_service, ha_get_states, ha_present_card"));
  assert(next.includes("case-sensitive"));
});

Deno.test("enrichErrorText — handles unquoted 'tool not found' phrasing", () => {
  const original = `Tool ha_make_coffee not found`;
  const next = enrichErrorText(original, SCHEMAS, ENABLED);
  assert(next.includes("Available tools:"));
});

Deno.test("enrichErrorText — leaves unrelated tool errors alone", () => {
  const original = `light.turn_on returned: HA error 500`;
  const next = enrichErrorText(original, SCHEMAS, ENABLED);
  assertEquals(next, original);
});

Deno.test("enrichErrorText — idempotent (already enriched text is returned unchanged)", () => {
  const original =
    `Validation failed for tool "ha_call_service":\n  - /domain: required\n\nCorrect schema for ha_call_service:\n{ "type": "object" }`;
  const next = enrichErrorText(original, SCHEMAS, ENABLED);
  assertEquals(next, original);
});

Deno.test("enrichErrorText — leaves a validation failure alone if the tool's schema isn't known", () => {
  const original = `Validation failed for tool "ha_unknown_thing":\n  - /x: bad`;
  const next = enrichErrorText(original, SCHEMAS, ENABLED);
  assertEquals(next, original);
});

Deno.test("enrichToolErrorMessage — only rewrites toolResult role messages", () => {
  const userMessage = {
    role: "user",
    content: [{ type: "text", text: `Validation failed for tool "ha_call_service":` }],
  };
  const same = enrichToolErrorMessage(userMessage, SCHEMAS, ENABLED);
  assertEquals(same, userMessage, "non-toolResult messages pass through untouched");
});

Deno.test("enrichToolErrorMessage — rewrites only the matching text part of a toolResult", () => {
  const original = {
    role: "toolResult",
    toolName: "ha_call_service",
    content: [
      { type: "text", text: `Validation failed for tool "ha_call_service":\n  - /domain: required` },
      { type: "text", text: "Some other unrelated note" },
    ],
  };
  const next = enrichToolErrorMessage(original, SCHEMAS, ENABLED);
  assert(next !== original, "returns a new object when there's something to enrich");
  assert(next.content[0].text.includes("Correct schema for"), "enriches the failure entry");
  assertEquals(next.content[1].text, "Some other unrelated note", "untouched parts pass through");
});
