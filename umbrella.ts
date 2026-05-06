// `ha_invoke` — uniform tool dispatcher. Two purposes:
//
//   1. As a future "extended-tool catch-all": tools the user doesn't pin to
//      the prefix become reachable only via ha_invoke, with a `describe`
//      mode the agent uses to fetch the schema JIT before executing. Today
//      every tool is still in the prefix, so this layer just adds an
//      alternative path — no token-budget change yet.
//
//   2. As a uniform invocation surface for tests / scripts / power users:
//      `ha_invoke({tool: "ha_call_service", args: …})` is indistinguishable
//      from a direct call. The dispatch table holds every tool by name.
//
// The "promote to core / demote to extended" lever is purely a matter of
// which tool defs `agent-registry.ts` puts in `customTools` at session
// build. The tool's execute() function is identical in either world.

import { Type } from "npm:@sinclair/typebox";

// deno-lint-ignore no-explicit-any
type ToolDef = any;

interface BuildOpts {
  /** Every tool the dispatch table can reach. Includes both pinned and
   *  extended tools — agent-registry decides what shows up in the prefix
   *  alongside this umbrella; ha_invoke can dispatch to any of them. */
  // deno-lint-ignore no-explicit-any
  allTools: any[];
  /** Names of the tools surfaced in ha_invoke's listing — the ones the
   *  agent should reach via ha_invoke. Pinned / core tools are typically
   *  excluded here so the listing doesn't waste tokens advertising what
   *  the agent already sees in the prefix. Default: every tool name in
   *  allTools. */
  extendedNames?: readonly string[];
}

function summarizeParameters(parameters: unknown): string {
  // TypeBox schemas are JSON Schema with a few extra fields. Pretty-print a
  // tight summary the model can read without dumping the whole tree.
  try {
    const json = JSON.stringify(parameters, null, 2);
    return json.length <= 1500 ? json : json.slice(0, 1500) + "\n… (truncated)";
  } catch {
    return "(parameter schema unavailable)";
  }
}

function describeTool(tool: ToolDef): string {
  const lines: string[] = [];
  lines.push(`Tool: ${tool.name}${tool.label ? ` (${tool.label})` : ""}`);
  lines.push("");
  lines.push(tool.description ?? "(no description)");
  lines.push("");
  lines.push("Parameters (JSON Schema):");
  lines.push(summarizeParameters(tool.parameters));
  return lines.join("\n");
}

/** Build the `ha_invoke` tool def. Capture the dispatch table at the
 *  call site so the umbrella keeps working across reset / rebuild — the
 *  bound array is the source of truth for what's invokable. */
export function buildInvokeTool(opts: BuildOpts): ToolDef {
  // deno-lint-ignore no-explicit-any
  const dispatchTable: Record<string, any> = {};
  for (const t of opts.allTools) {
    if (t?.name) dispatchTable[t.name] = t;
  }
  const listing = (opts.extendedNames ?? Object.keys(dispatchTable))
    .filter((n) => dispatchTable[n])
    .sort()
    .map((n) => {
      const t = dispatchTable[n];
      // First sentence of the description as the one-liner; cap at 120 chars.
      const oneLine = (t.description ?? "")
        .split(/(?<=[.!?])\s+/)[0]
        .replace(/\s+/g, " ")
        .slice(0, 120)
        .trim();
      return `  ${n} — ${oneLine}`;
    })
    .join("\n");

  const description = [
    "Dispatch to a Home Assistant tool by name. Two modes:",
    "",
    "  - describe=true  → returns the tool's description and parameter schema",
    "                    so you can see how to call it. Use this once before",
    "                    invoking a tool you haven't called this session.",
    "  - describe=false → forwards `args` to the tool's parameters and runs it.",
    "",
    "Use ha_invoke for tools that aren't already in your visible toolset",
    "(listed below). Tools in your visible toolset can be called directly —",
    "going through ha_invoke for those is unnecessary overhead.",
    "",
    "Available tools (callable via ha_invoke):",
    listing || "  (none)",
  ].join("\n");

  return {
    name: "ha_invoke",
    label: "Invoke",
    description,
    parameters: Type.Object({
      tool: Type.String({
        description: "The tool name to invoke (e.g. \"ha_get_history\"). " +
          "See the listing in this tool's description for what's available.",
      }),
      args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
        description: "Forwarded to the tool's `parameters`. Omit when " +
          "describe=true. The shape is whatever the target tool's schema " +
          "expects — call ha_invoke with describe=true first if you " +
          "haven't seen it before.",
      })),
      describe: Type.Optional(Type.Boolean({
        description: "When true, return the tool's description and " +
          "parameter schema instead of executing it. Use once per session " +
          "before invoking any tool whose schema you don't have memorised.",
      })),
    }),
    async execute(
      id: string,
      params: { tool: string; args?: Record<string, unknown>; describe?: boolean },
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: unknown,
    ) {
      const target = dispatchTable[params.tool];
      if (!target) {
        const known = Object.keys(dispatchTable).sort().join(", ");
        return {
          content: [{
            type: "text",
            text: `Unknown tool: "${params.tool}". Available: ${known}`,
          }],
          details: {},
        };
      }
      if (params.describe) {
        return {
          content: [{ type: "text", text: describeTool(target) }],
          details: {},
        };
      }
      return await target.execute(id, params.args ?? {}, signal, onUpdate, ctx);
    },
  };
}
