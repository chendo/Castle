// Input-modality detection for the active model. OpenAI-compat servers have
// no standard way to say "this model accepts images", so we ask each dialect
// we know in turn and take the first one that actually answers:
//
//   1. `/v1/models` entries carrying `architecture.input_modalities`
//      (OpenRouter shape; llmswarm in front of llama.cpp emits it too).
//   2. LM Studio's `/api/v0/models[/<id>]` — `vision: true` / `type: "vlm"`.
//   3. llama.cpp's `/props` — `modalities.vision` (per-model via `?model=`
//      when llama-server runs in router mode).
//
// A probe that gets no usable answer returns null so the next one runs.
// Proxies like llmswarm serve their SPA's index.html with a 200 for unknown
// paths, so a non-JSON content type counts as "no answer", not as an error.

export type InputModality = "text" | "image";

const TEXT_ONLY: InputModality[] = ["text"];
const TEXT_AND_IMAGE: InputModality[] = ["text", "image"];
const PROBE_TIMEOUT_MS = 2000;

function modalitiesFrom(vision: boolean): InputModality[] {
  return vision ? TEXT_AND_IMAGE : TEXT_ONLY;
}

/** `/v1/models` body → modalities for `modelId`, or null if the entry is
 *  missing or doesn't declare `architecture.input_modalities`. */
export function parseOpenAIModelsList(body: unknown, modelId: string): InputModality[] | null {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return null;
  const entry = data.find((m) => (m as { id?: unknown })?.id === modelId) as
    | { architecture?: { input_modalities?: unknown } }
    | undefined;
  const declared = entry?.architecture?.input_modalities;
  if (!Array.isArray(declared)) return null;
  return modalitiesFrom(declared.includes("image"));
}

/** LM Studio `/api/v0/models/<id>` body (or one `/api/v0/models` entry). */
export function parseLmStudioModel(body: unknown): InputModality[] | null {
  if (typeof body !== "object" || body === null) return null;
  const m = body as { type?: unknown; vision?: unknown };
  if (m.type === undefined && m.vision === undefined) return null;
  return modalitiesFrom(m.vision === true || m.type === "vlm");
}

/** llama.cpp `/props` body. Older llama-server builds predate `modalities`. */
export function parseLlamaCppProps(body: unknown): InputModality[] | null {
  const modalities = (body as { modalities?: { vision?: unknown } })?.modalities;
  if (typeof modalities?.vision !== "boolean") return null;
  return modalitiesFrom(modalities.vision);
}

/** GET `url` and return its JSON body, or null for any non-2xx / non-JSON
 *  response. Network errors propagate so the caller can log them once. */
async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown | null> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  const isJson = res.headers.get("content-type")?.includes("json") ?? false;
  if (!res.ok || !isJson) {
    await res.body?.cancel();
    return null;
  }
  return await res.json();
}

/**
 * Probe `baseUrl` (the OpenAI-compat `/v1` root) for `modelId`'s input
 * modalities. Falls back to text-only when no dialect answers. Never throws.
 */
export async function detectModelInput(
  baseUrl: string,
  apiKey: string,
  modelId: string,
): Promise<InputModality[]> {
  const v1 = baseUrl.replace(/\/$/, "");
  const root = v1.replace(/\/v1$/, "");
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const id = encodeURIComponent(modelId);

  const probes: Array<[string, () => Promise<InputModality[] | null>]> = [
    ["/v1/models", async () => parseOpenAIModelsList(await fetchJson(`${v1}/models`, headers), modelId)],
    ["/api/v0/models", async () => {
      const one = parseLmStudioModel(await fetchJson(`${root}/api/v0/models/${id}`, headers));
      if (one) return one;
      const list = await fetchJson(`${root}/api/v0/models`, headers) as { data?: Array<{ id?: string }> } | null;
      return parseLmStudioModel(list?.data?.find((m) => m.id === modelId));
    }],
    ["/props", async () => parseLlamaCppProps(await fetchJson(`${root}/props?model=${id}`, headers))],
  ];

  const failures: string[] = [];
  for (const [name, probe] of probes) {
    try {
      const input = await probe();
      if (input) {
        console.log(`[castle] capability probe: ${name} answered for ${modelId}`);
        return input;
      }
      failures.push(`${name}: no answer`);
    } catch (err) {
      failures.push(`${name}: ${(err as Error).message}`);
    }
  }
  console.warn(`[castle] capability probes failed (${failures.join("; ")}); assuming text-only`);
  return TEXT_ONLY;
}
