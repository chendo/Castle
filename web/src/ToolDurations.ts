// Per-tool-call duration tracker, in milliseconds. Populated by RemoteAgent
// from tool_execution_start / tool_execution_end timestamps; read by
// HAToolRenderer to surface "took N ms" annotations in the tool widget header.
//
// Lives as a module-level singleton because pi-web-ui's renderer registration
// receives raw params + result objects with no agent context, so the renderer
// has no other handle to per-call timing.

const startTimes = new Map<string, number>();
const durations = new Map<string, number>();

export function recordStart(toolCallId: string): void {
  startTimes.set(toolCallId, performance.now());
}

export function recordEnd(toolCallId: string): void {
  const start = startTimes.get(toolCallId);
  if (start !== undefined) {
    durations.set(toolCallId, performance.now() - start);
    startTimes.delete(toolCallId);
  }
}

/** Returns the duration in ms once the tool has finished, else undefined. */
export function getDuration(toolCallId: string): number | undefined {
  return durations.get(toolCallId);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m${rem}s`;
}
