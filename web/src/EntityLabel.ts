// Single source of truth for "what to call this entity in the UI".
//
// HA exposes three names per entity:
//   - entity_registry.name / .original_name → short, e.g. "Lamp"
//   - state.attributes.friendly_name        → device-prefixed, e.g.
//                                              "Bedroom Bedroom Lamp"
//   - entity_id                             → light.bedroom_lamp
//
// We push entity_registry.name as `label` over the WS. The dashboard
// and sidebar prefer it because it reads cleanly inside an area card
// (no repeated area prefix). Fall back through friendly_name → entity_id
// so we never render an empty string.

import type { EntityState } from "./WebSocketRemoteAgent";

export function entityLabel(s: EntityState): string {
  if (typeof s.label === "string" && s.label.length > 0) return s.label;
  const friendly = s.attributes?.friendly_name as string | undefined;
  if (friendly && friendly.length > 0) return friendly;
  return s.entity_id.split(".").pop() ?? s.entity_id;
}
