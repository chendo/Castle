// Per-fire execution path for scheduled tasks.
//
// Each trigger fire goes through fireTask(): gather context (camera frames),
// build a constrained chat-completion request with a strict JSON response
// schema, parse the decision, and persist a frame trail on disk. tasks.ts owns
// lifecycle; this module owns the LLM round-trip.
//
// The LLM never calls tools during a fire — frames are pre-attached, the
// narrative log is summarized inline, and the model returns one structured
// JSON object. This keeps fires predictable in cost and latency, which matters
// for tasks that tick every few minutes for hours.

import type { HAClient } from "./ha-client.ts";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";
import { mintObservationId, taskFramesDir, type Observation, type Task, type TaskNotification } from "./tasks.ts";

export interface FireOutcome {
  observation: Observation;
  notification?: TaskNotification;
}

const MAX_NARRATIVE_CHARS = 4_000;
const FIRE_TIMEOUT_MS = 60_000;

interface CapturedFrame {
  diskPath: string;
  bytes: Uint8Array;
  mimeType: string;
  ts: number;
}

export async function fireTask(task: Task, triggerKind: string, ha: HAClient): Promise<FireOutcome> {
  // Reminder path: any task without external observation context (cameras
  // today; state-history etc. in the future) short-circuits past the LLM.
  // The brief is the notification verbatim — no decision branch needed,
  // because there's nothing to decide. Avoids hour-of-thinking on a "remind
  // me at 5pm" task and avoids leaving the task stuck in `watching` if the
  // model arbitrarily picks `wait`.
  if (!task.context.cameraFrames) {
    return fireReminder(task, triggerKind);
  }

  const frames: CapturedFrame[] = [];
  const cap = await captureFrame(task, ha);
  if (cap) frames.push(cap);
  const recentFramePaths = collectRecentFramePaths(task, task.context.cameraFrames.lastN);
  const newFramePaths = frames.map((f) => f.diskPath);

  const decision = await askDecision(task, frames, triggerKind);

  const observation: Observation = {
    id: mintObservationId(),
    ts: Date.now(),
    triggerKind,
    framePaths: newFramePaths,
    narrative: decision.narrative,
    decision: decision.decision,
    confidence: decision.confidence,
  };

  let notification: TaskNotification | undefined;
  if (decision.decision === "notify" && decision.notify) {
    notification = {
      summary: decision.notify.summary,
      confidence: decision.confidence,
      evidence: { framePaths: [...recentFramePaths.slice(-3), ...newFramePaths], triggerKind },
      observationId: observation.id,
      ts: observation.ts,
    };
  }
  return { observation, notification };
}

function fireReminder(task: Task, triggerKind: string): FireOutcome {
  const ts = Date.now();
  const observation: Observation = {
    id: mintObservationId(),
    ts,
    triggerKind,
    framePaths: [],
    narrative: `Reminder fired (${triggerKind}).`,
    decision: "notify",
    confidence: 1,
  };
  return {
    observation,
    notification: {
      summary: task.brief,
      confidence: 1,
      evidence: { triggerKind, kind: "reminder" },
      observationId: observation.id,
      ts,
    },
  };
}

// ---------------------------------------------------------------------------
// Frame capture

async function captureFrame(task: Task, ha: HAClient): Promise<CapturedFrame | null> {
  const cf = task.context.cameraFrames!;
  try {
    const res = await ha.restCall(`/api/camera_proxy/${encodeURIComponent(cf.entity)}`);
    if (!res.ok) {
      console.warn(`[tasks] frame ${cf.entity} returned ${res.status}`);
      return null;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const mimeType = res.headers.get("content-type") ?? "image/jpeg";
    const ts = Date.now();
    const ext = mimeType.includes("png") ? "png" : "jpg";
    const dir = taskFramesDir(task.id);
    await Deno.mkdir(dir, { recursive: true });
    const fileName = `${ts}.${ext}`;
    const diskPath = `${dir}/${fileName}`;
    await Deno.writeFile(diskPath, bytes);
    return { diskPath, bytes, mimeType, ts };
  } catch (err) {
    console.warn(`[tasks] frame capture failed: ${(err as Error).message}`);
    return null;
  }
}

function collectRecentFramePaths(task: Task, n: number): string[] {
  const out: string[] = [];
  for (let i = task.observations.length - 1; i >= 0 && out.length < n; i--) {
    const obs = task.observations[i];
    for (let j = obs.framePaths.length - 1; j >= 0 && out.length < n; j--) {
      out.unshift(obs.framePaths[j]);
    }
  }
  return out;
}

async function readFrameAsImageContent(path: string): Promise<{ data: string; mimeType: string } | null> {
  try {
    const bytes = await Deno.readFile(path);
    const mimeType = path.endsWith(".png") ? "image/png" : "image/jpeg";
    return { data: encodeBase64(bytes), mimeType };
  } catch (err) {
    console.warn(`[tasks] could not read frame ${path}: ${(err as Error).message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// LLM call

interface DecisionResponse {
  decision: "wait" | "notify";
  narrative: string;
  confidence?: number;
  notify?: { summary: string };
}

async function askDecision(task: Task, freshFrames: CapturedFrame[], triggerKind: string): Promise<DecisionResponse> {
  const url = (Deno.env.get("LLM_URL") ?? "http://localhost:1234/v1").replace(/\/$/, "");
  const apiKey = Deno.env.get("LLM_API_KEY") ?? "";
  const modelId = Deno.env.get("MODEL_NAME") ?? "";
  if (!modelId) {
    return { decision: "wait", narrative: "(no model configured — skipping decision)" };
  }

  const recentPaths = collectRecentFramePaths(task, task.context.cameraFrames?.lastN ?? 5);
  // Re-read older frames from disk as base64; fresh frame is already in memory.
  const olderFrames = await Promise.all(
    recentPaths
      .filter((p) => !freshFrames.some((f) => f.diskPath === p))
      .map(readFrameAsImageContent),
  );
  const olderImages = olderFrames.filter((f): f is { data: string; mimeType: string } => f !== null);

  const narrativeLog = buildNarrativeLog(task);
  const systemPrompt = buildSystemPrompt(task);
  const userContent = buildUserContent(task, narrativeLog, triggerKind, olderImages, freshFrames);

  // json_schema is the modern OpenAI-compat shape and what LM Studio expects.
  // Older `json_object` returns 400 from LM Studio. Schema is permissive so a
  // strict implementation still accepts it; parseDecision is the source of
  // truth for output validation.
  const body = {
    model: modelId,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    temperature: 0.2,
    max_tokens: 800,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "watcher_decision",
        schema: {
          type: "object",
          properties: {
            decision: { type: "string", enum: ["wait", "notify"] },
            narrative: { type: "string" },
            confidence: { type: "number" },
            notify: {
              type: "object",
              properties: { summary: { type: "string" } },
            },
          },
          required: ["decision", "narrative"],
        },
      },
    } as Record<string, unknown>,
  };

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const res = await fetch(`${url}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FIRE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LLM ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  const raw = json.choices?.[0]?.message?.content ?? "";
  return parseDecision(raw);
}

function buildSystemPrompt(task: Task): string {
  return [
    "You are a watcher running on a Home Assistant install. Each tick you receive recent observations and decide whether to notify the user.",
    "",
    "Rules:",
    "- Reply with a single JSON object, no prose, no markdown fences.",
    "- decision: \"wait\" if the condition has not occurred; \"notify\" if it has.",
    "- narrative: one short sentence describing what you currently see (will be appended to the log).",
    "- confidence: 0.0–1.0; only notify when ≥ 0.7. If unsure, prefer wait.",
    "- notify.summary: one short sentence the user will see. Only present when decision = notify.",
    "",
    "Schema:",
    `{ "decision": "wait" | "notify", "narrative": "string", "confidence": number, "notify"?: { "summary": "string" } }`,
    "",
    `Task brief: ${task.brief}`,
  ].join("\n");
}

function buildNarrativeLog(task: Task): string {
  // Most recent first in source, but render oldest → newest for the LLM.
  const recent = task.observations.slice(-15);
  const lines = recent.map((o) => {
    const t = new Date(o.ts).toISOString().slice(11, 19);
    const dec = o.decision === "wait" ? "" : ` [${o.decision}]`;
    return `${t}${dec}: ${o.narrative}`;
  });
  let log = lines.join("\n");
  if (log.length > MAX_NARRATIVE_CHARS) {
    log = "…\n" + log.slice(log.length - MAX_NARRATIVE_CHARS + 2);
  }
  return log;
}

interface ChatContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

function buildUserContent(
  _task: Task,
  narrativeLog: string,
  triggerKind: string,
  olderImages: Array<{ data: string; mimeType: string }>,
  freshFrames: CapturedFrame[],
): ChatContentPart[] {
  const parts: ChatContentPart[] = [];
  parts.push({
    type: "text",
    text: `Trigger: ${triggerKind}\nNarrative log:\n${narrativeLog || "(empty)"}\n\nRecent frames (oldest → newest), then the most recent frame:`,
  });
  for (const img of olderImages) {
    parts.push({ type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.data}` } });
  }
  for (const f of freshFrames) {
    parts.push({ type: "image_url", image_url: { url: `data:${f.mimeType};base64,${encodeBase64(f.bytes)}` } });
  }
  if (olderImages.length === 0 && freshFrames.length === 0) {
    parts.push({ type: "text", text: "(No camera frames in this task — base your decision on the brief and narrative alone.)" });
  }
  parts.push({
    type: "text",
    text: `Decide now. Reply with the JSON object only.`,
  });
  return parts;
}

export function parseDecision(raw: string): DecisionResponse {
  let text = raw.trim();
  // Tolerate models that wrap in code fences despite response_format.
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  if (fenced) text = fenced[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { decision: "wait", narrative: `(LLM returned non-JSON: ${text.slice(0, 200)})` };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { decision: "wait", narrative: "(LLM returned non-object)" };
  }
  const obj = parsed as Record<string, unknown>;
  const decision = obj.decision === "notify" ? "notify" : "wait";
  const narrative = typeof obj.narrative === "string" ? obj.narrative : "";
  const confidence = typeof obj.confidence === "number" ? Math.max(0, Math.min(1, obj.confidence)) : undefined;
  let notify: { summary: string } | undefined;
  if (decision === "notify") {
    const n = obj.notify as Record<string, unknown> | undefined;
    if (n && typeof n.summary === "string" && n.summary.trim()) {
      notify = { summary: n.summary.trim() };
    } else {
      // Model said notify but didn't supply a summary — coerce to wait.
      return { decision: "wait", narrative: narrative || "(notify without summary — held)", confidence };
    }
    // Confidence floor — under 0.7 we hold.
    if (confidence !== undefined && confidence < 0.7) {
      return { decision: "wait", narrative: `${narrative} [held: confidence ${confidence.toFixed(2)} < 0.7]`, confidence };
    }
  }
  return { decision, narrative, confidence, notify };
}
