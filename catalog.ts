import type { HAState } from "./ha-client.ts";

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
    for (const [, area] of [...areas.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
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

export function buildAgentsMd(catalog: string, houseInfo?: { name: string; timezone: string; unit_system: string; location: string }): string {
  const info: Partial<{ name: string; timezone: string; unit_system: string; location: string }> = houseInfo ?? {};
  const us = typeof info.unit_system === "string" ? JSON.parse(info.unit_system) : info.unit_system;
  const tempUnit = (us?.temperature as string)?.toUpperCase() || "°C";

  return `# hai — Home Assistant Agent

You control a smart home. Be brief. Confirm actions with one sentence.

## House
- **Name:** ${info.name ?? "Home"}
- **Timezone:** ${info.timezone ?? "UTC"}
- **Location:** ${info.location ?? "Unknown"}
- **Unit system:** ${us?.length ? `${us.length}m` : ""}${us?.weight ? `${us.weight}kg` : ""}${tempUnit ? ` · Temperature: ${tempUnit}` : ""}

## Available entities
${catalog}

## Tool guidance
- Answering state questions: use "Current home state" provided in the user message. No tool needed.
- Controlling devices: ha_call_service.
- Sensor trends/history: ha_get_history (returns aggregated stats, not raw datapoints).
- State not in snapshot or stale: ha_get_states.

## Rules
- One-sentence answers where possible.
- After calling a service, confirm what you did.
- Never guess entity IDs — use only IDs listed above.
- Use area names naturally ("turn on the kitchen lights") and map to entity IDs from the list.
- The "Current home state" section at the end of your context changes every query. Keep your reasoning focused so LM Studio's prompt cache (which covers everything before it) stays valid.
`;
}
