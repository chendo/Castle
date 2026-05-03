import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  buildAgentsMd,
  buildCatalogData,
  buildServicesData,
  type CatalogData,
  type ServiceDomain,
} from "../catalog.ts";
import type { HAServices, HAState } from "../ha-client.ts";

const HOUSE = {
  name: "Test Home",
  timezone: "Australia/Melbourne",
  location: "-37.8136, 144.9631",
  unit_system: JSON.stringify({ temperature: "°C", length: "km", mass: "kg" }),
  country: "AU",
  language: "en",
  currency: "AUD",
};

const SAMPLE_CATALOG: CatalogData = {
  areas: [{
    name: "Kitchen",
    entities_by_domain: {
      light: [
        { entity_id: "light.kitchen_main", domain: "light", friendly_name: "Kitchen Main" },
      ],
    },
  }],
  unassigned: {
    sensor: [{ entity_id: "sensor.outside_temp", domain: "sensor", friendly_name: "Outside Temp" }],
  },
};

const SAMPLE_SERVICES: ServiceDomain[] = [{
  name: "light",
  services: [{
    name: "turn_on",
    fields: [{ name: "brightness_pct", required: false }],
    response: false,
    description: "Turn the light on",
  }],
}];

Deno.test("buildAgentsMd — section order is system → house → services → entities → reminders", () => {
  const md = buildAgentsMd({ houseInfo: HOUSE, services: SAMPLE_SERVICES, catalog: SAMPLE_CATALOG });
  const idx = (s: string) => md.indexOf(s);
  const system = idx("# hai — Home Assistant Agent");
  const house = idx("## House");
  const services = idx("## Services available");
  const entities = idx("## Areas and exposed entities");
  const reminders = idx("## Reminders");
  assert(system >= 0, "system header missing");
  assert(house > system, `house should follow system (${system}, ${house})`);
  assert(services > house, "services should follow house");
  assert(entities > services, "entities should follow services");
  assert(reminders > entities, "reminders should follow entities");
});

Deno.test("buildAgentsMd — house section includes localisation + unit fields", () => {
  const md = buildAgentsMd({ houseInfo: HOUSE });
  assert(md.includes("Test Home"));
  assert(md.includes("Australia/Melbourne"));
  assert(md.includes("AU"));
  assert(md.includes("AUD"));
  assert(/temperature=°C/.test(md));
  assert(/length=km/.test(md));
});

Deno.test("buildAgentsMd — services section omitted when none provided", () => {
  const md = buildAgentsMd({ houseInfo: HOUSE });
  assertEquals(md.includes("## Services available"), false);
  assert(md.indexOf("## Areas and exposed entities") > md.indexOf("## House"));
  assert(md.indexOf("## Reminders") > md.indexOf("## Areas and exposed entities"));
});

Deno.test("buildAgentsMd — services iterate per-domain with required/optional markers", () => {
  const md = buildAgentsMd({
    houseInfo: HOUSE,
    services: [{
      name: "weather",
      services: [{
        name: "get_forecasts",
        fields: [{ name: "type", required: true }, { name: "language", required: false }],
        response: true,
      }],
    }],
  });
  assert(md.includes("### weather"));
  assert(md.includes("get_forecasts(type!, language?)"));
  assert(md.includes("→ response (set return_response=true)"));
});

Deno.test("buildAgentsMd — areas + unassigned entities render under their domains", () => {
  const md = buildAgentsMd({ houseInfo: HOUSE, catalog: SAMPLE_CATALOG });
  assert(md.includes("**Areas:** Kitchen"));
  assert(md.includes("## Kitchen"));
  assert(md.includes("### light"));
  assert(md.includes("light.kitchen_main — Kitchen Main"));
  assert(md.includes("## Other"));
  assert(md.includes("sensor.outside_temp — Outside Temp"));
});

Deno.test("buildAgentsMd — survives malformed unit_system", () => {
  const md = buildAgentsMd({ houseInfo: { ...HOUSE, unit_system: "not-json" } });
  assert(md.includes("## House"));
  assert(!md.includes("not-json"));
});

// ---------------------------------------------------------------------------
// Data builders.
// ---------------------------------------------------------------------------

function state(entity_id: string, name?: string): HAState {
  return {
    entity_id,
    state: "on",
    attributes: name ? { friendly_name: name } : {},
    last_changed: "",
    last_updated: "",
  };
}

Deno.test("buildCatalogData — groups by area then by domain, sorted", () => {
  const states: HAState[] = [
    state("light.kitchen_main", "Kitchen Main"),
    state("switch.kitchen_kettle", "Kettle"),
    state("light.bedroom_lamp", "Bedroom Lamp"),
    state("sensor.outside_temp", "Outside Temp"), // unassigned
  ];
  const areas = new Map([
    ["bed", { name: "Bedroom", entities: new Set(["light.bedroom_lamp"]) }],
    ["kit", { name: "Kitchen", entities: new Set(["light.kitchen_main", "switch.kitchen_kettle"]) }],
  ]);
  const data = buildCatalogData(states, undefined, areas);
  // Areas sorted alphabetically: Bedroom, Kitchen
  assertEquals(data.areas.map((a) => a.name), ["Bedroom", "Kitchen"]);
  // Kitchen has both light + switch
  assertEquals(Object.keys(data.areas[1].entities_by_domain), ["light", "switch"]);
  assertEquals(data.areas[1].entities_by_domain.light[0].entity_id, "light.kitchen_main");
  // Outside_temp lands in unassigned/sensor
  assertEquals(data.unassigned.sensor[0].entity_id, "sensor.outside_temp");
});

Deno.test("buildCatalogData — exposed filter restricts entities", () => {
  const states: HAState[] = [
    state("light.kitchen_main"),
    state("light.bedroom_lamp"),
  ];
  const data = buildCatalogData(states, new Set(["light.kitchen_main"]));
  // No areas given → both end up unassigned, but exposed filter drops bedroom_lamp.
  assertEquals(data.unassigned.light?.length, 1);
  assertEquals(data.unassigned.light[0].entity_id, "light.kitchen_main");
});

Deno.test("buildServicesData — fields carry required flag, response detected", () => {
  const services: HAServices = {
    light: {
      turn_on: {
        description: "Turn it on",
        fields: { brightness_pct: { required: false }, transition: { required: false } },
      },
    },
    weather: {
      get_forecasts: {
        fields: { type: { required: true } },
        response: { optional: false },
      },
    },
  };
  const out = buildServicesData(services, new Set(["light", "weather"]));
  // Sorted alphabetically: light, weather
  assertEquals(out.map((d) => d.name), ["light", "weather"]);
  const turnOn = out[0].services[0];
  assertEquals(turnOn.name, "turn_on");
  assertEquals(turnOn.fields.find((f) => f.name === "brightness_pct")?.required, false);
  assertEquals(turnOn.response, false);
  const getForecasts = out[1].services[0];
  assertEquals(getForecasts.fields[0].required, true);
  assertEquals(getForecasts.response, true);
});

// ---------------------------------------------------------------------------
// Stability: re-ordering the inputs must not change the rendered bytes.
// The prompt cache invalidates on the first byte that changes, so any drift
// here translates directly into cache misses.
// ---------------------------------------------------------------------------

function shuffle<T>(xs: T[], seed: number): T[] {
  const out = xs.slice();
  // Deterministic Fisher-Yates with a tiny LCG so the test result itself is
  // reproducible across runs.
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

Deno.test("AGENTS.md output is byte-stable under input shuffling", () => {
  const states: HAState[] = [
    state("light.kitchen_main", "Kitchen Main"),
    state("light.kitchen_island", "Kitchen Island"),
    state("switch.kitchen_kettle", "Kettle"),
    state("light.bedroom_lamp", "Bedroom Lamp"),
    state("sensor.outside_temp", "Outside Temp"),
    state("binary_sensor.front_door", "Front Door"),
  ];

  const services: HAServices = {
    light: {
      turn_on: { fields: { brightness_pct: { required: false }, transition: { required: false }, kelvin: { required: false } } },
      turn_off: { fields: {} },
    },
    weather: {
      get_forecasts: { fields: { type: { required: true } }, response: { optional: false } },
    },
  };

  // Build areas by inserting in two different orders + with shuffled entity sets.
  const buildAreas = (order: "AB" | "BA", swap: boolean) => {
    const kit = { name: "Kitchen", entities: new Set(swap
      ? ["switch.kitchen_kettle", "light.kitchen_main", "light.kitchen_island"]
      : ["light.kitchen_island", "light.kitchen_main", "switch.kitchen_kettle"]) };
    const bed = { name: "Bedroom", entities: new Set(["light.bedroom_lamp"]) };
    const m = new Map<string, typeof kit>();
    if (order === "AB") { m.set("kit", kit); m.set("bed", bed); }
    else { m.set("bed", bed); m.set("kit", kit); }
    return m;
  };

  // Build services map with two different field-key insertion orders.
  const reorderFields = (svcs: HAServices, seed: number): HAServices => {
    const out: HAServices = {};
    const domainKeys = shuffle(Object.keys(svcs), seed);
    for (const d of domainKeys) {
      out[d] = {};
      const svcKeys = shuffle(Object.keys(svcs[d]), seed + 1);
      for (const s of svcKeys) {
        const def = svcs[d][s];
        const fieldEntries = shuffle(Object.entries(def.fields ?? {}), seed + 2);
        out[d][s] = { ...def, fields: Object.fromEntries(fieldEntries) };
      }
    }
    return out;
  };

  const renderWith = (statesOrder: HAState[], servicesIn: HAServices, areasOrder: "AB" | "BA", swap: boolean) =>
    buildAgentsMd({
      houseInfo: HOUSE,
      services: buildServicesData(servicesIn, new Set(["light", "weather"])),
      catalog: buildCatalogData(statesOrder, undefined, buildAreas(areasOrder, swap)),
    });

  const baseline = renderWith(states, services, "AB", false);
  const variant1 = renderWith(shuffle(states, 1), reorderFields(services, 1), "BA", true);
  const variant2 = renderWith(shuffle(states, 7), reorderFields(services, 7), "AB", true);
  const variant3 = renderWith(shuffle(states, 42), reorderFields(services, 42), "BA", false);

  assertEquals(variant1, baseline, "shuffle 1 produced different output");
  assertEquals(variant2, baseline, "shuffle 2 produced different output");
  assertEquals(variant3, baseline, "shuffle 3 produced different output");
});

Deno.test("buildServicesData — fields are sorted alphabetically", () => {
  const services: HAServices = {
    light: {
      turn_on: {
        // Insertion order is intentionally non-alpha
        fields: {
          transition: { required: false },
          brightness_pct: { required: false },
          kelvin: { required: false },
        },
      },
    },
  };
  const out = buildServicesData(services, new Set(["light"]));
  assertEquals(out[0].services[0].fields.map((f) => f.name), ["brightness_pct", "kelvin", "transition"]);
});

Deno.test("buildServicesData — homeassistant + recorder etc are blocked", () => {
  const services: HAServices = {
    homeassistant: { restart: {} },
    light: { turn_on: {} },
  };
  const out = buildServicesData(services, new Set(["homeassistant", "light"]));
  assertEquals(out.map((d) => d.name), ["light"]);
});
