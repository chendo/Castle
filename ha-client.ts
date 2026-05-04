export interface HAState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
}

export interface HAServiceField {
  description?: string;
  example?: unknown;
  required?: boolean;
  advanced?: boolean;
  default?: unknown;
  selector?: Record<string, unknown>;
}

export interface HAServiceDef {
  name?: string;
  description?: string;
  fields?: Record<string, HAServiceField>;
  target?: Record<string, unknown>;
  response?: { optional?: boolean };
}

/** Result of `get_services`: { domain: { service: HAServiceDef } } */
export type HAServices = Record<string, Record<string, HAServiceDef>>;

export interface HouseInfo {
  name: string;
  timezone: string;
  /** JSON-encoded unit_system from HA: { length, mass, temperature, pressure, volume, wind_speed, ... } */
  unit_system: string;
  /** "lat, lon" or "" if HA hasn't been configured with coordinates. */
  location: string;
  elevation?: number;
  country?: string;
  language?: string;
  currency?: string;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

export class HAClient {
  private ws!: WebSocket;
  private states = new Map<string, HAState>();
  private pending = new Map<number, Pending>();
  private msgId = 1;
  private _connected = false;
  private exposedEntities: Set<string> | undefined = undefined;

  constructor(private url: string, private token: string) {}

  async connect(): Promise<void> {
    const wsUrl = this.url.replace(/^http/, "ws").replace(/\/?$/, "") + "/api/websocket";
    console.log(`[ha] connecting to ${wsUrl}`);

    await new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      this.ws.onmessage = async (ev) => {
        const msg = JSON.parse(ev.data as string);
        switch (msg.type) {
          case "auth_required":
            this.ws.send(JSON.stringify({ type: "auth", access_token: this.token }));
            break;
          case "auth_ok":
            this._connected = true;
            this.notifyConnection(true);
            console.log(`[ha] authenticated (HA ${msg.ha_version})`);
            await this.fetchAllStates();
            await this.subscribeStateChanges();
            resolve();
            break;
          case "auth_invalid":
            reject(new Error(`HA auth failed: ${msg.message}`));
            break;
          case "result":
            this.handleResult(msg as Result);
            break;
          case "event":
            this.handleEvent(msg as EventMsg);
            break;
        }
      };

      this.ws.onerror = (e) => reject(e);
      this.ws.onclose = () => {
        const wasConnected = this._connected;
        this._connected = false;
        if (wasConnected) this.notifyConnection(false);
        console.warn("[ha] websocket closed");
      };
    });
  }

  private async fetchAllStates(): Promise<void> {
    const states = await this.call<HAState[]>({ type: "get_states" });
    for (const s of states) this.states.set(s.entity_id, s);
    console.log(`[ha] loaded ${this.states.size} entities`);
  }

  private subscribeStateChanges(): Promise<unknown> {
    return this.call({ type: "subscribe_events", event_type: "state_changed" });
  }

  /**
   * External listeners notified on every HA state_changed event AFTER the
   * internal state map is updated. Used by main.ts to fan out to WS clients.
   */
  private stateChangeListeners = new Set<(entityId: string, newState: HAState | null) => void>();

  onStateChange(listener: (entityId: string, newState: HAState | null) => void): () => void {
    this.stateChangeListeners.add(listener);
    return () => { this.stateChangeListeners.delete(listener); };
  }

  private connectionListeners = new Set<(connected: boolean) => void>();
  onConnectionChange(listener: (connected: boolean) => void): () => void {
    this.connectionListeners.add(listener);
    return () => { this.connectionListeners.delete(listener); };
  }
  private notifyConnection(connected: boolean): void {
    for (const l of this.connectionListeners) {
      try { l(connected); }
      catch (err) { console.warn("[ha] connection listener threw:", (err as Error).message); }
    }
  }

  private handleEvent(msg: EventMsg): void {
    const { entity_id, new_state } = msg.event.data;
    if (new_state) this.states.set(entity_id, new_state);
    else this.states.delete(entity_id);
    // Notify listeners after the local map update so anyone reading from
    // getAllStates() during the callback sees the new value.
    for (const l of this.stateChangeListeners) {
      try { l(entity_id, new_state ?? null); }
      catch (err) { console.warn("[ha] state_change listener threw:", (err as Error).message); }
    }
  }

  private handleResult(msg: Result): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.success) p.resolve(msg.result);
    else p.reject(new Error(JSON.stringify(msg.error)));
  }

  /** Call an HA REST endpoint with the bearer token (modern HA has no WS set_state). */
  async restCall(path: string, init: RequestInit = {}): Promise<Response> {
    const base = this.url.replace(/\/$/, "");
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.token}`);
    if (!headers.has("Content-Type") && init.body) headers.set("Content-Type", "application/json");
    return await fetch(`${base}${path.startsWith("/") ? path : `/${path}`}`, { ...init, headers });
  }

  call<T>(payload: Record<string, unknown>): Promise<T> {
    const id = this.msgId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ ...payload, id }));
    });
  }

  getAllStates(): HAState[] {
    return [...this.states.values()];
  }

  getState(entityId: string): HAState | undefined {
    return this.states.get(entityId);
  }

  async callService(
    domain: string,
    service: string,
    target?: { entity_id?: string },
    serviceData?: Record<string, unknown>,
    returnResponse = false,
  ): Promise<{ context: unknown; response?: unknown }> {
    return await this.call({
      type: "call_service",
      domain,
      service,
      target: target ?? {},
      service_data: serviceData ?? {},
      ...(returnResponse ? { return_response: true } : {}),
    });
  }

  async getHistory(entityId: string, start: Date, end: Date): Promise<unknown> {
    return this.call({
      type: "history/history_during_period",
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      entity_ids: [entityId],
      minimal_response: true,
      no_attributes: true,
    });
  }

  async getExposedEntities(): Promise<string[] | null> {
    if (this.exposedEntities !== undefined && this.exposedEntities !== null) return [...this.exposedEntities];
    try {
      const result = await this.call<{ exposed_entities: Record<string, unknown> }>({ type: "homeassistant/expose_entity/list" });
      this.exposedEntities = new Set(Object.keys(result.exposed_entities));
      console.log(`[ha] exposed entities: ${this.exposedEntities.size}`);
      return [...this.exposedEntities];
    } catch (err) {
      console.warn("[ha] failed to fetch exposed entities:", (err as Error).message);
      this.exposedEntities = undefined;
      return null;
    }
  }

  async getAreas(): Promise<Map<string, { name: string; entities: Set<string> }>> {
    try {
      // Areas live in the area registry. Entity-area assignment lives in the
      // ENTITY registry (entity-level override) with a fallback to the DEVICE
      // registry (the entity's device's area). state.attributes.area_id is
      // almost never populated, so the previous version of this method
      // dropped basically every entity into "Other".
      const areas = await this.call<Array<{ area_id: string; name: string; labels?: string[] }>>({ type: "config/area_registry/list" });
      const entityRegistry = await this.call<Array<{ entity_id: string; device_id?: string | null; area_id?: string | null }>>({ type: "config/entity_registry/list" });
      const deviceRegistry = await this.call<Array<{ id: string; area_id?: string | null }>>({ type: "config/device_registry/list" });

      const deviceToArea = new Map<string, string>();
      for (const d of deviceRegistry) {
        if (d.area_id) deviceToArea.set(d.id, d.area_id);
      }

      const entityToArea = new Map<string, string>();
      for (const e of entityRegistry) {
        if (e.area_id) {
          entityToArea.set(e.entity_id, e.area_id);
        } else if (e.device_id) {
          const inherited = deviceToArea.get(e.device_id);
          if (inherited) entityToArea.set(e.entity_id, inherited);
        }
      }

      const result = new Map<string, { name: string; entities: Set<string> }>();
      for (const area of areas) {
        const entities = new Set<string>();
        for (const [eid, aid] of entityToArea) {
          if (aid === area.area_id) entities.add(eid);
        }
        result.set(area.area_id, { name: area.name, entities });
      }
      console.log(`[ha] areas: ${result.size}, entities mapped to an area: ${entityToArea.size}`);
      return result;
    } catch (err) {
      console.warn("[ha] failed to fetch areas:", (err as Error).message);
      return new Map();
    }
  }

  private servicesCache: HAServices | null = null;

  /** Fetch the full service registry from HA (cached after first call). */
  async getServices(forceRefresh = false): Promise<HAServices> {
    if (this.servicesCache && !forceRefresh) return this.servicesCache;
    try {
      const result = await this.call<HAServices>({ type: "get_services" });
      this.servicesCache = result || {};
      return this.servicesCache;
    } catch (err) {
      console.warn("[ha] failed to fetch services:", (err as Error).message);
      this.servicesCache = {};
      return this.servicesCache;
    }
  }

  /** Lookup a single service definition. Returns undefined if unknown. */
  getServiceDef(domain: string, service: string): HAServiceDef | undefined {
    return this.servicesCache?.[domain]?.[service];
  }

  async getHouseInfo(): Promise<HouseInfo> {
    // `get_states` doesn't accept a target filter — it returns the whole list,
    // so the previous lookup silently produced defaults. Pull from the local
    // states map (the `zone.home` entity carries lat/lon/friendly_name) and
    // fall back to the WS `get_config` command for the locale/units block.
    const fallback: HouseInfo = { name: "Home", timezone: "UTC", unit_system: "{}", location: "" };
    try {
      const zone = this.states.get("zone.home");
      const zAttrs = (zone?.attributes ?? {}) as Record<string, unknown>;
      const lat = typeof zAttrs.latitude === "number" ? zAttrs.latitude.toFixed(4) : "";
      const lon = typeof zAttrs.longitude === "number" ? zAttrs.longitude.toFixed(4) : "";
      let core: Record<string, unknown> = {};
      try {
        core = await this.call<Record<string, unknown>>({ type: "get_config" }) ?? {};
      } catch {
        // Older HA / restricted token — fine, we'll fall back to whatever the zone gave us.
      }
      const elevation = typeof core.elevation === "number"
        ? core.elevation
        : (typeof zAttrs.elevation === "number" ? zAttrs.elevation : undefined);
      return {
        name: (core.location_name as string) || (zAttrs.friendly_name as string) || "Home",
        timezone: (core.time_zone as string) || "UTC",
        unit_system: JSON.stringify(core.unit_system ?? {}),
        location: lat && lon ? `${lat}, ${lon}` : "",
        elevation,
        country: typeof core.country === "string" ? core.country : undefined,
        language: typeof core.language === "string" ? core.language : undefined,
        currency: typeof core.currency === "string" ? core.currency : undefined,
      };
    } catch {
      return fallback;
    }
  }

  getExposedEntityCount(): number {
    if (this.exposedEntities === undefined) return -1;
    return this.exposedEntities.size;
  }

  /**
   * Synchronous exposure check. Returns true when the entity is in the cached
   * exposed-entities set. If the set hasn't been fetched yet (set is
   * undefined), returns true so we don't block legitimate calls before the
   * catalog has loaded — the UI / call_service path can re-check later if
   * needed.
   */
  isExposed(entityId: string): boolean {
    if (this.exposedEntities === undefined) return true;
    return this.exposedEntities.has(entityId);
  }

  /**
   * Flip exposure for one or more entities for the "conversation" assistant
   * (the namespace `homeassistant/expose_entity/list` uses). Drops the cached
   * set so the next getExposedEntities() refetches.
   */
  async setExposed(entityIds: string[], shouldExpose: boolean): Promise<void> {
    if (entityIds.length === 0) return;
    await this.call({
      type: "homeassistant/expose_entity",
      assistants: ["conversation"],
      entity_ids: entityIds,
      should_expose: shouldExpose,
    });
    if (shouldExpose) {
      if (this.exposedEntities) {
        for (const id of entityIds) this.exposedEntities.add(id);
      }
    } else {
      if (this.exposedEntities) {
        for (const id of entityIds) this.exposedEntities.delete(id);
      }
    }
  }

  get isConnected(): boolean {
    return this._connected;
  }
}

interface Result {
  id: number;
  success: boolean;
  result: unknown;
  error?: unknown;
}

interface EventMsg {
  event: {
    data: {
      entity_id: string;
      new_state: HAState;
    };
  };
}
