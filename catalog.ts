import nunjucks from "npm:nunjucks@3.2.4";
import type { HAServices, HAState, HouseInfo } from "./ha-client.ts";

// Domains to skip — they add noise without useful controllability
const SKIP_DOMAINS = new Set([
  "update", "device_tracker", "persistent_notification",
  "conversation", "tts", "stt", "wake_word",
]);

// Byte-comparison (UTF-16 code units). Locale-independent and host-independent
// — the same input always produces the same order, which the prompt cache
// requires. Avoid Intl.Collator and String.localeCompare here: both depend on
// the runtime's default locale and quietly drift across environments.
function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface AreaInfo { name: string; entities: Set<string> }

// ---------------------------------------------------------------------------
// Structured data — fed straight into the Jinja2 template so the template
// (templates/AGENTS.md.jinja2) can choose how to format every section. The TS
// here only filters and groups; layout decisions live in the template.
// ---------------------------------------------------------------------------

export interface CatalogEntity {
  entity_id: string;
  domain: string;
  friendly_name: string;
}

export interface CatalogArea {
  name: string;
  /** Entities in this area, grouped by domain. Domain keys are sorted. */
  entities_by_domain: Record<string, CatalogEntity[]>;
}

export interface CatalogData {
  /** Sorted by area name. Areas with no exposed entities are omitted. */
  areas: CatalogArea[];
  /** Entities in no area, grouped by domain. Empty object if none. */
  unassigned: Record<string, CatalogEntity[]>;
}

export interface ServiceField {
  name: string;
  required: boolean;
}

export interface ServiceItem {
  name: string;
  fields: ServiceField[];
  /** True when the service returns a payload (forecasts, calendar events, etc). */
  response: boolean;
  description?: string;
}

export interface ServiceDomain {
  name: string;
  services: ServiceItem[];
}

function entityFromState(s: HAState): CatalogEntity {
  const [domain] = s.entity_id.split(".");
  return {
    entity_id: s.entity_id,
    domain,
    friendly_name: (s.attributes.friendly_name as string) ?? s.entity_id,
  };
}

function groupByDomain(entities: CatalogEntity[]): Record<string, CatalogEntity[]> {
  const sorted = [...entities].sort((a, b) => byString(a.entity_id, b.entity_id));
  // Build with domain-key ordering so iteration in the template is alphabetical.
  const sortedDomains = [...new Set(sorted.map((e) => e.domain))].sort(byString);
  const out: Record<string, CatalogEntity[]> = {};
  for (const d of sortedDomains) out[d] = sorted.filter((e) => e.domain === d);
  return out;
}

export function buildCatalogData(
  states: HAState[],
  exposed?: Set<string>,
  areas?: Map<string, AreaInfo>,
): CatalogData {
  const filtered = states.filter((s) => {
    if (exposed !== undefined && !exposed.has(s.entity_id)) return false;
    const [domain] = s.entity_id.split(".");
    return !SKIP_DOMAINS.has(domain);
  }).map(entityFromState);

  if (!areas || areas.size === 0) {
    // No area data — everything is unassigned, grouped by domain.
    return { areas: [], unassigned: groupByDomain(filtered) };
  }

  const areaList: CatalogArea[] = [];
  const sortedAreas = [...areas.entries()].sort((a, b) => byString(a[1].name, b[1].name));
  const claimed = new Set<string>();

  for (const [, area] of sortedAreas) {
    const inArea = filtered.filter((e) => area.entities.has(e.entity_id));
    if (inArea.length === 0) continue;
    for (const e of inArea) claimed.add(e.entity_id);
    areaList.push({ name: area.name, entities_by_domain: groupByDomain(inArea) });
  }

  const unassigned = filtered.filter((e) => !claimed.has(e.entity_id));
  return {
    areas: areaList,
    unassigned: unassigned.length > 0 ? groupByDomain(unassigned) : {},
  };
}

/** Domains we never advertise services for in the system prompt. */
const SERVICE_BLOCKLIST_DOMAINS = new Set([
  "persistent_notification", "logger", "system_log", "recorder",
  "homeassistant", // huge & rarely needed; keep prompt small
]);

/** Always include these utility domains' services, even when no entities for them are exposed. */
const SERVICE_INCLUDE_ALWAYS = new Set(["script", "scene", "automation", "input_boolean", "notify"]);

/** Description fields can be paragraphs; trim to first line / 80 chars. */
function trimDescription(s: string | undefined): string | undefined {
  if (!s) return undefined;
  return s.split("\n")[0].slice(0, 80);
}

export function buildServicesData(services: HAServices, presentDomains: Set<string>): ServiceDomain[] {
  const targetDomains = new Set([...presentDomains, ...SERVICE_INCLUDE_ALWAYS]);
  const out: ServiceDomain[] = [];
  for (const domain of [...targetDomains].sort(byString)) {
    if (SERVICE_BLOCKLIST_DOMAINS.has(domain)) continue;
    const domainServices = services[domain];
    if (!domainServices) continue;
    const items: ServiceItem[] = [];
    for (const [svcName, def] of Object.entries(domainServices).sort((a, b) => byString(a[0], b[0]))) {
      const fields = def.fields ?? {};
      // Sort fields alphabetically too — HA emits them in declaration order
      // which can shift between integration versions and silently invalidate
      // the prompt cache. Alpha is the only fully deterministic choice.
      const fieldList: ServiceField[] = Object.entries(fields)
        .map(([name, f]) => ({ name, required: f?.required === true }))
        .sort((a, b) => byString(a.name, b.name));
      items.push({
        name: svcName,
        fields: fieldList,
        response: def.response != null,
        description: trimDescription(def.description),
      });
    }
    if (items.length === 0) continue;
    out.push({ name: domain, services: items });
  }
  return out;
}

export function extractDomains(states: HAState[]): Set<string> {
  const out = new Set<string>();
  for (const s of states) {
    const i = s.entity_id.indexOf(".");
    if (i > 0) out.add(s.entity_id.slice(0, i));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Template renderer.
// ---------------------------------------------------------------------------

export interface DisabledTool {
  name: string;
  description: string;
}

interface BuildAgentsMdOptions {
  houseInfo?: Partial<HouseInfo>;
  services?: ServiceDomain[];
  catalog?: CatalogData;
  /** Tools that exist but are disabled in settings — surfaced so the agent can
   * tell the user which switch to flip in Settings → Tools. */
  disabledTools?: DisabledTool[];
}

// AGENTS.md is the cached system prompt. Layout lives in
// templates/AGENTS.md.jinja2 — the template controls every formatting choice
// (section order, area grouping, service rendering, etc). Section order should
// stay stable→volatile so the LM Studio / OpenAI-compat KV cache stays warm.

const TEMPLATE_PATH = new URL("./templates/AGENTS.md.jinja2", import.meta.url);
const TEMPLATE_SOURCE = Deno.readTextFileSync(TEMPLATE_PATH);

const env = new nunjucks.Environment(null, { autoescape: false, throwOnUndefined: false });

// deno-lint-ignore no-explicit-any
function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return {}; }
}

export function buildAgentsMd(opts: BuildAgentsMdOptions = {}): string {
  const houseRaw = opts.houseInfo ?? {};
  const us = typeof houseRaw.unit_system === "string"
    ? safeParse(houseRaw.unit_system)
    : (houseRaw.unit_system ?? {});
  // Hand the template a flat house object with unit_system as a parsed map so
  // it can iterate / pick fields / format however it wants.
  const house = { ...houseRaw, unit_system: us };
  const rendered = env.renderString(TEMPLATE_SOURCE, {
    house,
    services: opts.services ?? [],
    catalog: opts.catalog ?? { areas: [], unassigned: {} },
    disabled_tools: opts.disabledTools ?? [],
  });
  return rendered.endsWith("\n") ? rendered : rendered + "\n";
}
