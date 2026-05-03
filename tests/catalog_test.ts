import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildAgentsMd } from "../catalog.ts";

const HOUSE = {
  name: "Test Home",
  timezone: "Australia/Melbourne",
  location: "-37.8136, 144.9631",
  unit_system: JSON.stringify({ temperature: "°C", length: "km", mass: "kg" }),
  country: "AU",
  language: "en",
  currency: "AUD",
};

Deno.test("buildAgentsMd — section order is system → house → services → entities → reminders", () => {
  const md = buildAgentsMd("(catalog goes here)", {
    houseInfo: HOUSE,
    servicesMd: "### light\n- turn_on(brightness_pct?)",
  });

  const idx = (s: string) => md.indexOf(s);
  const system = idx("# hai — Home Assistant Agent");
  const house = idx("## House");
  const services = idx("## Services available");
  const entities = idx("## Areas and exposed entities");
  const reminders = idx("## Reminders");

  assert(system >= 0, "system header missing");
  assert(house > system, `house should follow system (system=${system}, house=${house})`);
  assert(services > house, "services should follow house");
  assert(entities > services, "entities should follow services");
  assert(reminders > entities, "reminders should follow entities");
});

Deno.test("buildAgentsMd — house section includes localisation + unit fields", () => {
  const md = buildAgentsMd("(catalog)", { houseInfo: HOUSE });
  assert(md.includes("Test Home"));
  assert(md.includes("Australia/Melbourne"));
  assert(md.includes("AU"));
  assert(md.includes("AUD"));
  assert(md.includes("language=") || md.includes("Language:**"));
  assert(/temperature=°C/.test(md));
  assert(/length=km/.test(md));
});

Deno.test("buildAgentsMd — services section omitted when none provided", () => {
  const md = buildAgentsMd("(catalog)", { houseInfo: HOUSE });
  assertEquals(md.includes("## Services available"), false);
  // Entities still come right after house and before reminders.
  assert(md.indexOf("## Areas and exposed entities") > md.indexOf("## House"));
  assert(md.indexOf("## Reminders") > md.indexOf("## Areas and exposed entities"));
});

Deno.test("buildAgentsMd — survives malformed unit_system", () => {
  const md = buildAgentsMd("(catalog)", { houseInfo: { ...HOUSE, unit_system: "not-json" } });
  // Doesn't throw, doesn't dump "[object Object]" or raw JSON nonsense
  assert(md.includes("## House"));
  assert(!md.includes("not-json"));
});
