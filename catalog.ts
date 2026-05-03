import nunjucks from "npm:nunjucks@3.2.4";
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

// AGENTS.md is the cached system prompt. Layout lives in
// templates/AGENTS.md.jinja2 — section order is fixed there as:
//   1. System prompt        (constant)
//   2. House metadata       (changes only when HA config is edited)
//   3. Services             (changes only when integrations are added/removed)
//   4. Areas + entities     (changes whenever entities are added/exposed/renamed)
//   5. Reminders            (constant)
// Volatile sections sit near the end so the LM Studio / OpenAI-compat KV cache
// stays warm across regenerations: a fresh entity invalidates only sections 4
// and 5, while sections 1–3 keep hitting the cache.

const TEMPLATE_PATH = new URL("./templates/AGENTS.md.jinja2", import.meta.url);
const TEMPLATE_SOURCE = Deno.readTextFileSync(TEMPLATE_PATH);

// nunjucks is the canonical JS port of Jinja2; we render strings (no FS loader)
// so this works the same in Deno tests and in the live container.
const env = new nunjucks.Environment(null, { autoescape: false, throwOnUndefined: false });

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

export function buildAgentsMd(catalog: string, opts: BuildAgentsMdOptions = {}): string {
  const houseInfo = opts.houseInfo ?? {};
  const us = typeof houseInfo.unit_system === "string"
    ? safeParse(houseInfo.unit_system)
    : houseInfo.unit_system;
  const rendered = env.renderString(TEMPLATE_SOURCE, {
    house: houseInfo,
    units: formatUnitSystem(us),
    services_md: opts.servicesMd ?? "",
    catalog,
  });
  // nunjucks preserves the trailing newline from the template; ensure exactly one.
  return rendered.endsWith("\n") ? rendered : rendered + "\n";
}
