import { assertEquals } from "jsr:@std/assert@1";
import { parseLlamaCppProps, parseLmStudioModel, parseOpenAIModelsList } from "../model-capabilities.ts";

// Trimmed from llmswarm's real /v1/models response.
const LLMSWARM_MODELS = {
  object: "list",
  data: [
    { id: "Qwen3.6-35B-A3B", owned_by: "llamacpp", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
    { id: "Qwen3.8-27B-Q4_K_M", owned_by: "llamacpp", architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
  ],
};

Deno.test("parseOpenAIModelsList — image in input_modalities means vision", () => {
  assertEquals(parseOpenAIModelsList(LLMSWARM_MODELS, "Qwen3.6-35B-A3B"), ["text", "image"]);
});

Deno.test("parseOpenAIModelsList — text-only declaration is a definite answer", () => {
  assertEquals(parseOpenAIModelsList(LLMSWARM_MODELS, "Qwen3.8-27B-Q4_K_M"), ["text"]);
});

Deno.test("parseOpenAIModelsList — no answer when the model or architecture is absent", () => {
  assertEquals(parseOpenAIModelsList(LLMSWARM_MODELS, "missing-model"), null);
  assertEquals(parseOpenAIModelsList({ data: [{ id: "plain" }] }, "plain"), null);
  assertEquals(parseOpenAIModelsList(null, "plain"), null);
});

Deno.test("parseLmStudioModel — vision flag or vlm type means vision", () => {
  assertEquals(parseLmStudioModel({ type: "vlm" }), ["text", "image"]);
  assertEquals(parseLmStudioModel({ type: "llm", vision: true }), ["text", "image"]);
  assertEquals(parseLmStudioModel({ type: "llm" }), ["text"]);
});

Deno.test("parseLmStudioModel — no answer for bodies without type/vision", () => {
  assertEquals(parseLmStudioModel({ id: "x" }), null);
  assertEquals(parseLmStudioModel(undefined), null);
});

Deno.test("parseLlamaCppProps — reads modalities.vision", () => {
  assertEquals(parseLlamaCppProps({ modalities: { vision: true, audio: false } }), ["text", "image"]);
  assertEquals(parseLlamaCppProps({ modalities: { vision: false } }), ["text"]);
});

Deno.test("parseLlamaCppProps — no answer from builds that predate modalities", () => {
  assertEquals(parseLlamaCppProps({ default_generation_settings: {} }), null);
});
