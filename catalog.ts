import type { HAServices, HAState, HouseInfo } from "./ha-client.ts";

// Domains to skip — they add noise without useful controllability
const SKIP_DOMAINS = new Set([
  "update", "device_tracker", "persistent_notification",
  "conversation", "tts", "stt", "wake_word",
]);

interface AreaInfo { name: string; entities: Set<string> }

export function buildCatalog(states: HAState[], exposed?: Set<string>, areas?: Map<string, AreaInfo>): string {
  const filtered = states.filter(s => {
    if (exposed !== undefined && !exposed.has(s.entity_id)) return false;
    const [domain] = s.entity_id.split(".");
    return !SKIP_DOMAINS.has(domain);
  });

  // Group by area if available
  if (areas && areas.size > 0) {
    const lines: string[] = [];
    const sortedAreas = [...areas.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
    const areaNamesWithEntities = sortedAreas
      .filter(([, area]) => filtered.some((s) => area.entities.has(s.entity_id)))
      .map(([, area]) => area.name);
    if (areaNamesWithEntities.length > 0) {
      lines.push(`**Areas:** ${areaNamesWithEntities.join(", ")}`);
      lines.push("");
    }

    for (const [, area] of sortedAreas) {
      const areaEntities = filtered.filter(s => area.entities.has(s.entity_id));
      if (areaEntities.length === 0) continue;

      lines.push(`## ${area.name}`);
      // Group by domain within area
      const byDomain = new Map<string, string[]>();
      for (const s of areaEntities.sort((a, b) => a.entity_id.localeCompare(b.entity_id))) {
        const [domain] = s.entity_id.split(".");
        if (!byDomain.has(domain)) byDomain.set(domain, []);
        const name = (s.attributes.friendly_name as string) ?? s.entity_id;
        byDomain.get(domain)!.push(`  ${s.entity_id} — ${name}`);
      }
      for (const [domain, entities] of [...byDomain.entries()].sort()) {
        lines.push(`### ${domain}`);
        lines.push(...entities.sort());
      }
      lines.push("");
    }

    // Entities without an area
    const areaEntityIds = new Set<string>();
    for (const area of areas.values()) {
      for (const eid of area.entities) areaEntityIds.add(eid);
    }
    const unassigned = filtered.filter(s => !areaEntityIds.has(s.entity_id));
    if (unassigned.length > 0) {
      lines.push(`## Other`);
      const byDomain = new Map<string, string[]>();
      for (const s of unassigned.sort((a, b) => a.entity_id.localeCompare(b.entity_id))) {
        const [domain] = s.entity_id.split(".");
        if (!byDomain.has(domain)) byDomain.set(domain, []);
        const name = (s.attributes.friendly_name as string) ?? s.entity_id;
        byDomain.get(domain)!.push(`  ${s.entity_id} — ${name}`);
      }
      for (const [domain, entities] of [...byDomain.entries()].sort()) {
        lines.push(`### ${domain}`);
        lines.push(...entities.sort());
      }
    }

    return lines.join("\n");
  }

  // Fallback: group by domain only
  const byDomain = new Map<string, string[]>();
  for (const s of filtered) {
    const [domain] = s.entity_id.split(".");
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    const name = (s.attributes.friendly_name as string) ?? s.entity_id;
    byDomain.get(domain)!.push(`  ${s.entity_id} — ${name}`);
  }

  const lines: string[] = [];
  for (const [domain, entities] of [...byDomain.entries()].sort()) {
    lines.push(`### ${domain}`);
    lines.push(...entities.sort());
  }
  return lines.join("\n");
}

export function formatStates(states: HAState[], exposed?: Set<string>): string {
  return states
    .filter(s => {
      if (exposed !== undefined && !exposed.has(s.entity_id)) return false;
      const [domain] = s.entity_id.split(".");
      return !SKIP_DOMAINS.has(domain);
    })
    .map(s => {
      const attrs: string[] = [];
      const a = s.attributes;
      if (a.brightness != null) attrs.push(`brightness=${Math.round((a.brightness as number) / 2.55)}%`);
      if (a.color_temp != null) attrs.push(`color_temp=${a.color_temp}`);
      if (a.temperature != null) attrs.push(`set=${a.temperature}°`);
      if (a.current_temperature != null) attrs.push(`current=${a.current_temperature}°`);
      if (a.humidity != null) attrs.push(`humidity=${a.humidity}%`);
      if (a.unit_of_measurement != null) attrs.push(`unit=${a.unit_of_measurement}`);
      const suffix = attrs.length ? ` [${attrs.join(", ")}]` : "";
      return `${s.entity_id}: ${s.state}${suffix}`;
    })
    .join("\n");
}

/** Domains we never advertise services for in the system prompt. */
const SERVICE_BLOCKLIST_DOMAINS = new Set([
  "persistent_notification", "logger", "system_log", "recorder",
  "homeassistant", // huge & rarely needed; keep prompt small
]);

/** Build a compact one-line-per-service index, scoped to domains present in the entity list. */
export function buildServicesMd(services: HAServices, presentDomains: Set<string>): string {
  const lines: string[] = [];
  // Always include a few utility domains the agent commonly uses regardless of entity presence.
  const includeAlways = new Set(["script", "scene", "automation", "input_boolean", "notify"]);
  const targetDomains = new Set([...presentDomains, ...includeAlways]);

  for (const domain of [...targetDomains].sort()) {
    if (SERVICE_BLOCKLIST_DOMAINS.has(domain)) continue;
    const domainServices = services[domain];
    if (!domainServices) continue;
    const serviceLines: string[] = [];
    for (const [svcName, def] of Object.entries(domainServices).sort((a, b) => a[0].localeCompare(b[0]))) {
      const fields = def.fields ?? {};
      const fieldNames = Object.entries(fields)
        .map(([name, f]) => f?.required ? `${name}!` : `${name}?`)
        .join(", ");
      const responseHint = def.response ? " → response (set return_response=true)" : "";
      const desc = def.description ? ` — ${def.description.split("\n")[0].slice(0, 80)}` : "";
      serviceLines.push(`- ${svcName}(${fieldNames})${responseHint}${desc}`);
    }
    if (serviceLines.length === 0) continue;
    lines.push(`### ${domain}`);
    lines.push(...serviceLines);
    lines.push("");
  }
  return lines.length === 0 ? "" : lines.join("\n");
}

export function extractDomains(states: HAState[]): Set<string> {
  const out = new Set<string>();
  for (const s of states) {
    const i = s.entity_id.indexOf(".");
    if (i > 0) out.add(s.entity_id.slice(0, i));
  }
  return out;
}

interface BuildAgentsMdOptions {
  houseInfo?: Partial<HouseInfo>;
  servicesMd?: string;
}

// AGENTS.md is the cached system prompt. The section order below is fixed:
//   1. System prompt        (constant)
//   2. House metadata       (changes only when HA config is edited)
//   3. Services             (changes only when integrations are added/removed)
//   4. Areas + entities     (changes whenever entities are added/exposed/renamed)
//   5. Reminders            (constant)
// Volatile sections sit near the end so the LM Studio / OpenAI-compat KV cache
// stays warm across regenerations: a fresh entity invalidates only sections 4
// and 5, while sections 1–3 keep hitting the cache.

const SYSTEM_PROMPT = `# hai — Home Assistant Agent

You control a smart home. Be brief. Confirm actions with one sentence.`;

const REMINDERS = `## Reminders

Tool guidance:
- Answering state questions: use "Current home state" provided in the user message. No tool needed.
- Controlling devices: ha_call_service. Use service_data for parameters; set return_response=true for services that return data (weather.get_forecasts, calendar.get_events, etc).
- Inspecting entity capabilities (color modes, hvac modes, current attributes): ha_get_entity.
- Sensor trends/history: ha_get_history (numeric → bucketed min/max; binary/enum → state-change list).
- State not in snapshot or stale: ha_get_states.

Rules:
- One-sentence answers where possible.
- After calling a service, confirm what you did.
- Never guess entity IDs — use only IDs listed above.
- Use area names naturally ("turn on the kitchen lights") and map to entity IDs from the list.
- The "Current home state" block appended to the user message changes every query; everything before it is cached, so keep the cached prefix stable.`;

function renderHouse(info: Partial<HouseInfo>): string {
  const us = typeof info.unit_system === "string" ? safeParse(info.unit_system) : info.unit_system;
  const lines = [
    "## House",
    `- **Name:** ${info.name ?? "Home"}`,
    `- **Timezone:** ${info.timezone ?? "UTC"}`,
    `- **Location:** ${info.location || "Unknown"}`,
  ];
  if (typeof info.elevation === "number") lines.push(`- **Elevation:** ${info.elevation}m`);
  if (info.country) lines.push(`- **Country:** ${info.country}`);
  if (info.language) lines.push(`- **Language:** ${info.language}`);
  if (info.currency) lines.push(`- **Currency:** ${info.currency}`);
  const unitLine = formatUnitSystem(us);
  if (unitLine) lines.push(`- **Units:** ${unitLine}`);
  return lines.join("\n");
}

// deno-lint-ignore no-explicit-any
function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return {}; }
}

// deno-lint-ignore no-explicit-any
function formatUnitSystem(us: any): string {
  if (!us || typeof us !== "object") return "";
  const parts: string[] = [];
  if (us.temperature) parts.push(`temperature=${String(us.temperature).toUpperCase()}`);
  if (us.length) parts.push(`length=${us.length}`);
  if (us.mass) parts.push(`mass=${us.mass}`);
  if (us.volume) parts.push(`volume=${us.volume}`);
  if (us.pressure) parts.push(`pressure=${us.pressure}`);
  if (us.wind_speed) parts.push(`wind_speed=${us.wind_speed}`);
  return parts.join(" · ");
}

function renderServices(servicesMd: string | undefined): string {
  if (!servicesMd) return "";
  return [
    "## Services available",
    "`!` = required, `?` = optional. Field types/defaults can be inferred from name; ask via ha_get_entity if unsure.",
    "",
    servicesMd,
  ].join("\n");
}

function renderEntities(catalog: string): string {
  return ["## Areas and exposed entities", catalog].join("\n");
}

export function buildAgentsMd(catalog: string, opts: BuildAgentsMdOptions = {}): string {
  const sections = [
    SYSTEM_PROMPT,
    renderHouse(opts.houseInfo ?? {}),
    renderServices(opts.servicesMd),
    renderEntities(catalog),
    REMINDERS,
  ].filter((s) => s.length > 0);
  return sections.join("\n\n") + "\n";
}
