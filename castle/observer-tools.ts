// The observer's toolset: four tools plus three bookkeeping ones.
//
// DRY RUN IS STRUCTURAL, NOT A FLAG. `perform_action` is named and shaped like
// the real thing — HA's own current term for a service call, with the same
// arguments as ha_call_service — so the observer plans exactly as it would if
// it were allowed to act, and the dry run measures the behaviour we would
// actually ship. But the function object registered here is built by
// buildShadowAction(), which closes over no HAClient and has no code path that
// reaches Home Assistant. Going live later means swapping the implementation
// behind a gate, not rewriting the prompt.
//
// Four tools is deliberate. Every schema is tokens in every request, and the
// observer's whole value is reacting quickly, so the toolset is the smallest
// one that can do the job. The cost is real and worth naming: with no
// ha_get_automation_trace the observer can see that an automation fired and
// that nothing changed, but not why. That is the intended split — the warning
// is the deliverable, diagnosis is a conversation, and the Observer view's
// "Ask about this" hands it to the chat agent, which does have the trace tool.
//
// castle_flag / castle_remember / castle_forget are NOT shadows. They are real
// actions that really happen in both dry-run and live mode: flagging puts a row
// in the Observer view, which is how the observer tells you something is wrong.
// Only house-mutating tools are shadowed.
//
// These three are also deliberately absent from settings.ts ALL_TOOL_NAMES.
// That constant drives settings.enabledTools, the Settings dialog checkboxes,
// and the *disabled tools* block of the chat agent's system prompt — listing
// them there would tell the chat agent "castle_remember is disabled, ask the
// user to enable it", which is nonsense, and would churn chat's cached prompt
// prefix for nothing.

import { Type } from "npm:@sinclair/typebox";
import type { HAClient } from "./ha-client.ts";
import { buildTools } from "./tools.ts";
import type { MemoryStore } from "./observer-memory.ts";
import type { ObservationBody, Severity } from "./observer-store.ts";

type BuiltTool = ReturnType<typeof buildTools>[number];
type ToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };

function text(s: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text: s }], details };
}

/** Underlying Castle tools the observer's read tools delegate to. */
const DELEGATES = {
  get_state: "ha_get_states",
  get_history: "ha_get_history",
  get_camera_snapshot: "ha_get_camera_snapshot",
} as const;

/** Names the observer is allowed to have. Asserted in tests — the dry-run
 *  guarantee is only as good as this list staying closed. */
export const OBSERVER_TOOL_NAMES = [
  "get_state",
  "get_history",
  "get_camera_snapshot",
  "perform_action",
  "castle_flag",
  "castle_remember",
  "castle_forget",
] as const;

/** Snapshots are by far the most expensive thing the observer can do on a
 *  local model, and looking through cameras is a privacy decision — so both a
 *  per-pass cap and a per-camera cooldown apply, on top of the allowlist. */
const SNAPSHOT_COOLDOWN_MS = 5 * 60_000;

export interface ObserverToolDeps {
  ha: HAClient;
  memory: MemoryStore;
  /** Records a finding. Returns the observation id, or null when the store
   *  suppressed it (already dismissed by the user). */
  emit: (body: ObservationBody) => Promise<string | null>;
  /** Cameras the user has explicitly allowed. Empty means vision is off. */
  cameras: () => string[];
  /** True when the model can actually see images; when false the snapshot tool
   *  is not registered at all rather than silently returning nothing useful. */
  multimodal: boolean;
  now?: () => number;
}

/** Per-pass mutable budget. Reset by the runtime before each pass. */
export class SnapshotBudget {
  private takenThisPass = 0;
  private lastByCamera = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}

  reset(): void {
    this.takenThisPass = 0;
  }

  /** Returns null when allowed, or the reason to hand back to the model. */
  check(entityId: string, allowed: string[]): string | null {
    if (allowed.length === 0) {
      return "No cameras are enabled for the observer. The user has not allowed any in " +
        "Settings -> Observer, so no snapshot can be taken. Report what the non-visual " +
        "evidence supports and stop.";
    }
    if (!allowed.includes(entityId)) {
      return `${entityId} is not one of the cameras enabled for the observer. ` +
        `Allowed: ${allowed.join(", ")}.`;
    }
    if (this.takenThisPass >= 1) {
      return "Snapshot budget for this pass is already spent (1 per pass). " +
        "Work with what you have.";
    }
    const last = this.lastByCamera.get(entityId);
    if (last !== undefined && this.now() - last < SNAPSHOT_COOLDOWN_MS) {
      const wait = Math.ceil((SNAPSHOT_COOLDOWN_MS - (this.now() - last)) / 60_000);
      return `${entityId} was already checked recently; not again for ~${wait}m.`;
    }
    return null;
  }

  spend(entityId: string): void {
    this.takenThisPass++;
    this.lastByCamera.set(entityId, this.now());
  }
}

/**
 * perform_action: the shadow write. Same arguments as ha_call_service, no
 * HAClient in scope. `action` rather than `service` matches HA's current
 * terminology, which is what the model has most likely seen.
 */
function buildShadowAction(deps: ObserverToolDeps): BuiltTool {
  const tool = {
    name: "perform_action",
    label: "Perform Action",
    shadow: true,
    description:
      "Perform a Home Assistant action (a service call) on an entity — turn something " +
      "on or off, set a value, run a script. OBSERVATION MODE: this records the action " +
      "you would take and does NOT execute it. Nothing changes. Call it exactly as you " +
      "would for real, then move on — do not re-read state to check whether it worked, " +
      "and do not retry.",
    parameters: Type.Object({
      domain: Type.String({ description: "e.g. light, switch, climate, cover, script" }),
      action: Type.String({ description: "e.g. turn_on, turn_off, set_temperature" }),
      entity_id: Type.Optional(Type.String({ description: "Target entity ID" })),
      data: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
        description: "Extra parameters, e.g. {brightness_pct: 50}",
      })),
      reason: Type.String({
        description: "One short sentence: why this action, citing what you saw.",
      }),
    }),
    async execute(
      _id: string,
      params: { domain: string; action: string; entity_id?: string; data?: Record<string, unknown>; reason: string },
    ): Promise<ToolResult> {
      // Validate as if this were the real call. An action the observer could
      // not actually have made is worthless to a future live mode, and how
      // often that happens is itself a dry-run measurement.
      const services = await deps.ha.getServices();
      const domainServices = services[params.domain];
      if (!domainServices) {
        return text(`Unknown domain "${params.domain}". Nothing recorded.`);
      }
      if (!(params.action in domainServices)) {
        const known = Object.keys(domainServices).slice(0, 15).join(", ");
        return text(`Unknown action "${params.domain}.${params.action}". Known: ${known}. Nothing recorded.`);
      }
      if (params.entity_id && !deps.ha.getState(params.entity_id)) {
        return text(`No such entity: ${params.entity_id}. Nothing recorded — never invent entity ids.`);
      }

      // Recorded under the canonical Castle tool name and argument shape, so a
      // future live mode can replay it verbatim through ha_call_service.
      const id = await deps.emit({
        type: "proposal",
        tool: "ha_call_service",
        args: {
          domain: params.domain,
          service: params.action,
          ...(params.entity_id ? { entity_id: params.entity_id } : {}),
          ...(params.data ? { service_data: params.data } : {}),
        },
        reason: params.reason,
        entities: params.entity_id ? [params.entity_id] : [],
      });
      if (id === null) {
        return text("Already dismissed by the user previously — not recorded again. Move on.");
      }
      return text(
        `DRY RUN - recorded as ${id}. Nothing changed and nothing will. ` +
          `Do not retry or verify; move on.`,
      );
    },
  };
  return tool as unknown as BuiltTool;
}

function buildFlagTool(deps: ObserverToolDeps): BuiltTool {
  const tool = {
    name: "castle_flag",
    label: "Flag",
    description:
      "Raise a concern for the user — something is wrong, degraded, or worth knowing. " +
      "This one really does happen: it puts a row in the Observer view. Every entity you " +
      "name must exist. Use sparingly; silence is the expected outcome of most passes.",
    parameters: Type.Object({
      severity: Type.Union(
        [Type.Literal("info"), Type.Literal("warn"), Type.Literal("critical")],
        { description: "info = worth knowing, warn = degraded, critical = acting now would be reasonable" },
      ),
      summary: Type.String({ description: "One line. No preamble." }),
      detail: Type.Optional(Type.String({ description: "Only if it carries a fact the summary cannot." })),
      entities: Type.Array(Type.String(), { description: "Entity ids this is about. Must exist." }),
    }),
    async execute(
      _id: string,
      params: { severity: Severity; summary: string; detail?: string; entities: string[] },
    ): Promise<ToolResult> {
      const unknown = params.entities.filter((e) => !deps.ha.getState(e));
      if (unknown.length > 0) {
        // The primary anti-hallucination guardrail: a finding that names an
        // entity HA does not have cannot be created at all.
        return text(
          `No such entities: ${unknown.join(", ")}. Nothing recorded. ` +
            `Only cite entity ids you saw in the batch or in a tool result.`,
        );
      }
      const id = await deps.emit({
        type: "concern",
        severity: params.severity,
        summary: params.summary,
        detail: params.detail,
        entities: params.entities,
      });
      if (id === null) return text("Already dismissed by the user previously — not raised again. Move on.");
      return text(`Flagged as ${id}.`);
    },
  };
  return tool as unknown as BuiltTool;
}

function buildMemoryTools(deps: ObserverToolDeps): BuiltTool[] {
  const remember = {
    name: "castle_remember",
    label: "Remember",
    description:
      "Save a durable note about this household — something still true next month. " +
      "Survives context compaction, so this is the only way to keep something. " +
      "Good: 'nobody home Tue/Thu daytime', 'the garage sensor is known-flaky, user is aware'. " +
      "Bad: anything about a single event. Consolidate rather than piling up near-duplicates; " +
      "the user reads this file.",
    parameters: Type.Object({
      note: Type.String({ description: "One line, self-contained." }),
      section: Type.Optional(Type.String({ description: "e.g. Household, Preferences learned" })),
    }),
    async execute(_id: string, params: { note: string; section?: string }): Promise<ToolResult> {
      const note = await deps.memory.remember(params.note, params.section);
      return text(`Remembered as ${note.id}.`);
    },
  };

  const forget = {
    name: "castle_forget",
    label: "Forget",
    description: "Delete a note by its [m_xxx] id — wrong, stale, or superseded by one you consolidated.",
    parameters: Type.Object({ id: Type.String({ description: "The [m_xxx] id" }) }),
    async execute(_id: string, params: { id: string }): Promise<ToolResult> {
      const gone = await deps.memory.forget(params.id);
      return text(gone ? `Forgot ${params.id}.` : `No note with id ${params.id}.`);
    },
  };

  return [remember, forget] as unknown as BuiltTool[];
}

/** Wrap the real camera tool with the allowlist, per-pass cap and cooldown. */
function gateCamera(base: BuiltTool, deps: ObserverToolDeps, budget: SnapshotBudget): BuiltTool {
  // deno-lint-ignore no-explicit-any
  const inner = (base as any).execute.bind(base);
  const tool = {
    // deno-lint-ignore no-explicit-any
    ...(base as any),
    name: "get_camera_snapshot",
    label: "Camera Snapshot",
    description:
      "Look at a camera. Use only when a specific event makes a specific camera worth " +
      "checking — never speculatively. One per pass. Describe only what you can actually " +
      "see; if the image is dark, empty or unclear, say so and stop. Do not infer a person " +
      "from an event alone.",
    async execute(id: string, params: { entity_id: string }, ...rest: unknown[]): Promise<ToolResult> {
      const refusal = budget.check(params.entity_id, deps.cameras());
      if (refusal) return text(refusal);
      budget.spend(params.entity_id);
      return await inner(id, params, ...rest);
    },
  };
  return tool as unknown as BuiltTool;
}

/**
 * Build the observer's toolset.
 *
 * The read tools are the real Castle implementations under shorter names —
 * behaviour, truncation and formatting all stay identical to what the chat
 * agent gets, which is one fewer thing that can diverge.
 */
export function buildObserverTools(
  deps: ObserverToolDeps,
  budget: SnapshotBudget = new SnapshotBudget(deps.now),
): BuiltTool[] {
  // allowUnexposedWrites is irrelevant (no real writes) but reads are ungated
  // anyway; multimodal drives whether the camera tool can feed the image back.
  const base = buildTools(deps.ha, { multimodal: deps.multimodal });
  const byName = new Map(base.map((t) => [t.name as string, t]));

  const out: BuiltTool[] = [];
  for (const [name, delegate] of Object.entries(DELEGATES)) {
    const impl = byName.get(delegate);
    if (!impl) throw new Error(`observer toolset: ${delegate} missing from buildTools`);
    if (name === "get_camera_snapshot") {
      // Vision on a text-only model would burn a tool call to return an image
      // the model cannot see, so don't offer it at all.
      if (!deps.multimodal) continue;
      out.push(gateCamera(impl, deps, budget));
      continue;
    }
    // deno-lint-ignore no-explicit-any
    out.push({ ...(impl as any), name } as unknown as BuiltTool);
  }

  out.push(buildShadowAction(deps));
  out.push(buildFlagTool(deps));
  out.push(...buildMemoryTools(deps));
  return out;
}
