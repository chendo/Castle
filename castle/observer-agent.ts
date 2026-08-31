// The observer's pi-coding-agent session.
//
// Separate from the chat session, with its own agentDir (and therefore its own
// system prompt at <DATA_DIR>/observer/AGENTS.md) so observer passes never
// land in the user's conversation and never eat the user's context window.
//
// Long-lived and resumed across restarts, so it keeps some continuity of what
// it has been seeing. Context is bounded by pi-coding-agent's own compaction
// rather than a hand-rolled trimmer: at 64k it summarises and keeps the most
// recent 16k. Anything that must outlive that lives in MEMORY.md, which is
// re-injected into every pass.
//
// RESUMING A TRANSCRIPT is the one place this feature knowingly re-enters the
// territory that killed the 0.3.0 tasks subsystem ("stale persisted state
// re-armed dead triggers across restarts"). The guards that make it safe:
//
//   - The transcript is inert. It holds messages, not triggers. Every timer
//     and subscription is rebuilt from code + settings on boot and no code
//     path reads the JSONL to decide to do anything.
//   - The write tool is a shadow with no HAClient in scope, so a poisoned
//     context produces a wrong recorded observation, never a wrong action.
//   - The resume target is discarded when it is stale, when the prompt or
//     toolset version moved, or when it fails to parse.
//   - resetContext() is a one-click escape that keeps memory.
//
// If any of those are dropped later, revisit the decision rather than the guard.

import { createAgentSession, SessionManager, SettingsManager } from "npm:@mariozechner/pi-coding-agent";
import type { AgentSession } from "npm:@mariozechner/pi-coding-agent";
import type { HAClient } from "./ha-client.ts";
import { getLocalModel } from "./agent.ts";
import { DATA_DIR, SOURCE_DIR } from "./paths.ts";
import { loadSettings } from "./settings.ts";
import { buildObserverTools, SnapshotBudget, type ObserverToolDeps } from "./observer-tools.ts";
import { TOOL_BUDGET } from "./observer-prompts.ts";
import type { PassKind } from "./observer-store.ts";

export const OBSERVER_DIR = `${DATA_DIR}/observer`;
const OBSERVER_SESSIONS_DIR = `${OBSERVER_DIR}/sessions`;
const VERSION_FILE = `${OBSERVER_DIR}/prompt-version`;

/**
 * Bump whenever the observer's system prompt, toolset or pass-prompt shape
 * changes. A resumed transcript from before the change would be reasoning
 * against rules and tools that no longer exist, so it is discarded instead.
 */
export const OBSERVER_PROMPT_VERSION = "1";

/** Resuming a transcript older than this is more likely to mislead than help —
 *  the house has moved on. */
const MAX_RESUME_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Identical-call guard. Tighter than chat's 5: the main way a shadow write
 *  loops is re-reading state, seeing nothing changed, and trying again. */
const MAX_IDENTICAL_CALLS = 2;

export interface ObserverSessionDeps {
  ha: HAClient;
  tools: Omit<ObserverToolDeps, "ha" | "multimodal">;
}

/** Everything a pass needs from the session, plus the per-pass budgets. */
export interface ObserverSession {
  session: AgentSession;
  snapshots: SnapshotBudget;
  /** Reset per-turn counters. Called before each pass. */
  beginPass(kind: PassKind): void;
  /** Tool calls made during the pass that just ran. */
  toolCalls(): number;
  sessionFile(): string | undefined;
}

/**
 * Pick the JSONL to resume, or undefined to start fresh. Exported for tests:
 * the discard rules are the safety story, so they get asserted directly.
 */
export async function pickResumeTarget(
  dir: string,
  versionFile: string,
  now: number,
  currentVersion = OBSERVER_PROMPT_VERSION,
): Promise<string | undefined> {
  let version: string;
  try {
    version = (await Deno.readTextFile(versionFile)).trim();
  } catch {
    return undefined; // never run, or version file lost — start clean
  }
  if (version !== currentVersion) return undefined;

  let newest: { path: string; mtime: number } | undefined;
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile || !entry.name.endsWith(".jsonl")) continue;
      const path = `${dir}/${entry.name}`;
      const stat = await Deno.stat(path);
      const mtime = stat.mtime?.getTime() ?? 0;
      if (!newest || mtime > newest.mtime) newest = { path, mtime };
    }
  } catch {
    return undefined;
  }
  if (!newest) return undefined;
  if (now - newest.mtime > MAX_RESUME_AGE_MS) return undefined;
  return newest.path;
}

let sessionPromise: Promise<ObserverSession> | null = null;

/** Tear down the in-memory session. The next pass rebuilds it, resuming the
 *  same file. Called on settings changes and by the reset button. */
export function recreateObserverSession(): Promise<void> {
  const live = sessionPromise;
  sessionPromise = null;
  if (!live) return Promise.resolve();
  return live.then(
    (s) => {
      try { s.session.agent.abort(); } catch { /* not streaming */ }
    },
    () => { /* never built */ },
  );
}

/** Start a genuinely fresh context: new transcript, memory and observations
 *  preserved. The escape hatch for when it has talked itself into something. */
export async function resetObserverContext(): Promise<void> {
  await recreateObserverSession();
  try {
    await Deno.remove(OBSERVER_SESSIONS_DIR, { recursive: true });
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      console.warn("[observer] could not clear sessions:", (err as Error).message);
    }
  }
  console.log("[observer] context reset");
}

export function peekObserverSession(): Promise<ObserverSession> | null {
  return sessionPromise;
}

export function getObserverSession(deps: ObserverSessionDeps): Promise<ObserverSession> {
  if (!sessionPromise) sessionPromise = build(deps);
  return sessionPromise;
}

async function build(deps: ObserverSessionDeps): Promise<ObserverSession> {
  const settings = await loadSettings();
  const model = getLocalModel();
  // The observer's window is its own setting — it is doing a different job
  // from chat and should not inherit chat's budget.
  model.contextWindow = settings.observer.contextWindow;
  const multimodal = Array.isArray(model.input) && model.input.includes("image");

  await Deno.mkdir(OBSERVER_SESSIONS_DIR, { recursive: true });
  const resume = await pickResumeTarget(OBSERVER_SESSIONS_DIR, VERSION_FILE, Date.now());
  await Deno.writeTextFile(VERSION_FILE, OBSERVER_PROMPT_VERSION);

  const snapshots = new SnapshotBudget();
  const customTools = buildObserverTools({ ...deps.tools, ha: deps.ha, multimodal }, snapshots);

  const result = await createAgentSession({
    cwd: SOURCE_DIR,
    agentDir: OBSERVER_DIR,
    model,
    noTools: "builtin",
    tools: customTools.map((t) => t.name as string),
    customTools,
    sessionManager: resume
      ? SessionManager.open(resume, OBSERVER_SESSIONS_DIR, SOURCE_DIR)
      : SessionManager.create(SOURCE_DIR, OBSERVER_SESSIONS_DIR),
    settingsManager: SettingsManager.inMemory({
      compaction: {
        enabled: true,
        reserveTokens: 4096,
        // "Keep the most recent 16k and summarise the rest." Memory.md is what
        // carries anything that must outlive this.
        keepRecentTokens: 16384,
      },
    }),
    // Triage against a pre-filtered, pre-rendered batch is recognition, not
    // planning. Reasoning tokens here are pure latency.
    thinkingLevel: "off",
  });

  console.log(
    `[observer] session ready (${resume ? "resumed" : "fresh"}, ${settings.observer.contextWindow} ctx, ` +
      `tools: ${customTools.map((t) => t.name).join(", ")})`,
  );

  let budget = TOOL_BUDGET.reactive;
  let calls = 0;
  const fingerprints = new Map<string, number>();

  const previousBefore = result.session.agent.beforeToolCall;
  result.session.agent.beforeToolCall = async (ctx, signal) => {
    if (previousBefore) {
      const r = await previousBefore(ctx, signal);
      if (r?.block) return r;
    }
    calls++;
    if (calls > budget) {
      queueMicrotask(() => result.session.agent.abort());
      return {
        block: true,
        reason: `Tool budget for this pass (${budget}) is spent. Report what you have and stop.`,
      };
    }
    // deno-lint-ignore no-explicit-any
    const name = (ctx as any).toolCall?.name ?? "(unknown)";
    // deno-lint-ignore no-explicit-any
    const key = `${name}:${JSON.stringify((ctx as any).args ?? {})}`;
    const n = (fingerprints.get(key) ?? 0) + 1;
    fingerprints.set(key, n);
    if (n >= MAX_IDENTICAL_CALLS) {
      queueMicrotask(() => result.session.agent.abort());
      return {
        block: true,
        reason: `You already called ${name} with these arguments. ` +
          `Nothing you do changes state in observation mode, so repeating it cannot help. Stop.`,
      };
    }
    return undefined;
  };

  return {
    session: result.session,
    snapshots,
    beginPass(kind: PassKind) {
      budget = TOOL_BUDGET[kind];
      calls = 0;
      fingerprints.clear();
      snapshots.reset();
    },
    toolCalls: () => calls,
    sessionFile: () => {
      // deno-lint-ignore no-explicit-any
      return (result as any).sessionFile ?? undefined;
    },
  };
}
