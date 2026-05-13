// Renderer-side helper for tool headers. Combines the per-tool summary text
// with a right-aligned duration chip so the eye can scan straight down the
// chat for "what happened" on the left and "how long it took" on the right.
//
// `renderHeader` / `renderCollapsibleHeader` (from pi-web-ui) wrap their text
// argument in a `flex items-center gap-2` container, so a `ml-auto` span
// inside the summary template pushes itself to the far right of the row.

import { html, type TemplateResult } from "lit";
import { formatDuration } from "./ToolDurations";

export function summaryWithDuration(
  baseSummary: string | TemplateResult,
  durationMs: number | undefined,
): string | TemplateResult {
  if (durationMs === undefined) return baseSummary;
  return html`
    <span class="truncate">${baseSummary}</span>
    <span class="ml-auto pl-2 opacity-70 tabular-nums whitespace-nowrap">${formatDuration(durationMs)}</span>
  `;
}
