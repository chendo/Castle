// One-off smoke test for ha_get_automation_trace's WS calls.
// Connects to HA, runs trace/list + trace/get, and prints what
// formatAutomationTrace would render. Not part of the regular test suite.
import { HAClient } from "../ha-client.ts";
import { formatAutomationTrace } from "../tools.ts";

const HA_URL = Deno.env.get("HA_URL") ?? "http://homeassistant.local:8123";
const HA_TOKEN = Deno.env.get("HA_TOKEN") ?? "";
const automation_id = Deno.args[0] ?? "1776351689829";

const ha = new HAClient(HA_URL, HA_TOKEN);
await ha.connect();

const list = await ha.call<Array<Record<string, unknown>>>({
  type: "trace/list",
  domain: "automation",
  item_id: automation_id,
});
console.log(`trace/list returned ${Array.isArray(list) ? list.length : 0} entries`);
if (!Array.isArray(list) || list.length === 0) {
  console.log("(no traces available — automation hasn't run since HA last started)");
  Deno.exit(0);
}
list.sort((a, b) => {
  const ta = (a.timestamp as { start?: string })?.start ?? "";
  const tb = (b.timestamp as { start?: string })?.start ?? "";
  return tb.localeCompare(ta);
});
const latest = list[0];
console.log("latest run:", JSON.stringify({
  run_id: latest.run_id,
  state: latest.state,
  start: (latest.timestamp as Record<string, unknown>)?.start,
  trigger: latest.trigger,
}, null, 2));

const trace = await ha.call<Record<string, unknown>>({
  type: "trace/get",
  domain: "automation",
  item_id: automation_id,
  run_id: latest.run_id as string,
});
console.log("\n--- formatAutomationTrace output ---");
console.log(formatAutomationTrace(trace));
console.log("--- end ---");
Deno.exit(0);
