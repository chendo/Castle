// Append-only log of successful tool invocations, plus a selector that
// picks "hot" tools to auto-pin to the prefix at boot. Failed tool calls
// are anti-signal (the agent picked the wrong tool for the job, or the
// tool errored) so we only record successes.
//
// Storage: .pi-agent/tool_usage.jsonl, one line per call:
//   {"ts": 1730000000000, "tool": "ha_get_history", "ok": true}
//
// Read on boot, append on each successful call. The append is fire-and-
// forget (no caller awaits it) so it never blocks the tool's response.

const PI_AGENT_DIR = new URL(".pi-agent/", import.meta.url).pathname.replace(/\/$/, "");
const USAGE_PATH = `${PI_AGENT_DIR}/tool_usage.jsonl`;

interface UsageEntry {
  ts: number;
  tool: string;
  ok: boolean;
}

/** Append a single tool-call record to the usage log. Fire-and-forget;
 *  callers shouldn't await this. Errors are swallowed because tool calls
 *  shouldn't fail just because we can't write to the log. */
export function recordToolCall(tool: string, ok: boolean): void {
  const line = JSON.stringify({ ts: Date.now(), tool, ok }) + "\n";
  // Deno.writeTextFile with append+create is the simplest atomic-ish path
  // here. The file is single-writer (one Castle process), so there's no
  // concurrent-append worry.
  Deno.writeTextFile(USAGE_PATH, line, { append: true, create: true })
    .catch((err) => {
      console.warn(`[tool-usage] couldn't write log:`, (err as Error).message);
    });
}

export interface UsageStats {
  windowDays: number;
  /** Successful-call counts keyed by tool name. */
  countsByTool: Record<string, number>;
  /** Total entries scanned (for diagnostics). */
  totalScanned: number;
}

/** Load the last N days of successful tool calls and bucket them by tool
 *  name. Lines older than the window or that fail to parse are skipped.
 *  Returns an empty stats object when the file doesn't exist (first-run
 *  case) — no special bootstrap needed. */
export async function loadRecentUsage(windowDays = 14): Promise<UsageStats> {
  const cutoff = Date.now() - windowDays * 86_400_000;
  const counts: Record<string, number> = {};
  let totalScanned = 0;
  try {
    const raw = await Deno.readTextFile(USAGE_PATH);
    for (const line of raw.split("\n")) {
      if (!line) continue;
      totalScanned++;
      try {
        const e = JSON.parse(line) as UsageEntry;
        if (e.ok !== true) continue;
        if (typeof e.ts !== "number" || e.ts < cutoff) continue;
        if (typeof e.tool !== "string") continue;
        counts[e.tool] = (counts[e.tool] ?? 0) + 1;
      } catch { /* malformed line — skip */ }
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      console.warn(`[tool-usage] couldn't read log:`, (err as Error).message);
    }
  }
  return { windowDays, countsByTool: counts, totalScanned };
}

/** Pick up to `topK` candidate tool names whose usage count meets the
 *  `floor` threshold over the window. Sorted by count desc; ties broken
 *  by tool name alpha for determinism. The caller filters out names
 *  already manually-pinned or disabled before passing them in. */
export function selectAutoPins(
  stats: UsageStats,
  candidates: readonly string[],
  topK = 3,
  floor = 5,
): string[] {
  return [...candidates]
    .map((name) => ({ name, count: stats.countsByTool[name] ?? 0 }))
    .filter(({ count }) => count >= floor)
    .sort((a, b) => (b.count - a.count) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, topK)
    .map(({ name }) => name);
}

/** Wrap a tool's execute() to record a usage entry on success. The
 *  recording is fire-and-forget so it doesn't add latency to the tool
 *  response. We only count successful calls — failures are noise (the
 *  agent picked the wrong tool, or the tool errored), not signal that
 *  the tool deserves prefix promotion. */
// deno-lint-ignore no-explicit-any
export function wrapWithUsageLog<T extends { name: string; execute: (...args: any[]) => Promise<any> }>(
  tool: T,
): T {
  const original = tool.execute.bind(tool);
  return {
    ...tool,
    // deno-lint-ignore no-explicit-any
    execute: async (...args: any[]) => {
      const result = await original(...args);
      const ok = !(result?.isError === true);
      recordToolCall(tool.name, ok);
      return result;
    },
  } as T;
}

/** Wipe the usage log (e.g. user clicked "Clear usage history" in Settings).
 *  Returns true if a file existed and was removed; false if there was
 *  nothing to remove. */
export async function clearUsageLog(): Promise<boolean> {
  try {
    await Deno.remove(USAGE_PATH);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}
