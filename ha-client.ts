export interface HAState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
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
        this._connected = false;
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

  private handleEvent(msg: EventMsg): void {
    const { entity_id, new_state } = msg.event.data;
    if (new_state) this.states.set(entity_id, new_state);
    else this.states.delete(entity_id);
  }

  private handleResult(msg: Result): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.success) p.resolve(msg.result);
    else p.reject(new Error(JSON.stringify(msg.error)));
  }

  private call<T>(payload: Record<string, unknown>): Promise<T> {
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

  async getHistory(entityId: string, hours = 24): Promise<unknown> {
    const end = new Date();
    const start = new Date(end.getTime() - hours * 3_600_000);
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
      const areas = await this.call<Array<{ id: string; name: string; labels: string[] }>>({ type: "config/area_registry/list" });
      const entityToArea = new Map<string, string>();
      for (const s of this.states.values()) {
        if (s.attributes?.area_id) {
          entityToArea.set(s.entity_id, s.attributes.area_id as string);
        }
      }
      const result = new Map<string, { name: string; entities: Set<string> }>();
      for (const area of areas) {
        const entities = new Set<string>();
        for (const [eid, aid] of entityToArea) {
          if (aid === area.id) entities.add(eid);
        }
        result.set(area.id, { name: area.name, entities });
      }
      return result;
    } catch (err) {
      console.warn("[ha] failed to fetch areas:", (err as Error).message);
      return new Map();
    }
  }

  async getHouseInfo(): Promise<{ name: string; timezone: string; unit_system: string; location: string }> {
    try {
      const ha = await this.call<HAState>({ type: "get_states", target: { entity_id: "homeassistant" } });
      const attrs = (ha as HAState)?.attributes ?? {};
      return {
        name: (attrs.friendly_name as string) || "Home",
        timezone: (attrs.time_zone as string) || "UTC",
        unit_system: JSON.stringify(attrs.unit_system || {}),
        location: `${attrs.latitude?.toFixed(4)}, ${attrs.longitude?.toFixed(4)}`.replace(/, NaN, NaN$/, ""),
      };
    } catch {
      return { name: "Home", timezone: "UTC", unit_system: "{}", location: "" };
    }
  }

  getExposedEntityCount(): number {
    if (this.exposedEntities === undefined) return -1;
    return this.exposedEntities.size;
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
