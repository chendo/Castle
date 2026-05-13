# Home Assistant API Reference

Local reference distilled from <https://developers.home-assistant.io/docs/api/websocket/> and <https://developers.home-assistant.io/docs/api/rest/>. Saved so future agent sessions don't need to refetch.

## WebSocket API

### Auth handshake

```text
server → { "type": "auth_required", "ha_version": "..." }
client → { "type": "auth", "access_token": "..." }
server → { "type": "auth_ok" }   // or { "type": "auth_invalid", "message": "..." }
```

After auth, every command from the client carries an integer `id`. Responses correlate by id.

### Standard result envelope

```json
{ "id": 24, "type": "result", "success": true, "result": <command-specific payload> }
```

On failure:

```json
{ "id": 24, "type": "result", "success": false, "error": { "code": "...", "message": "..." } }
```

### Commands (verbatim payload shapes)

#### `call_service` — with optional response

```json
{
  "id": 24,
  "type": "call_service",
  "domain": "light",
  "service": "turn_on",
  "service_data": { "color_name": "beige", "brightness": 101 },
  "target": { "entity_id": "light.kitchen" },
  "return_response": true
}
```

Response when `return_response: true`:

```json
{
  "id": 24, "type": "result", "success": true,
  "result": {
    "context": { "id": "...", "parent_id": null, "user_id": "..." },
    "response": <service-specific payload, or null>
  }
}
```

> The `result` always includes a `response` field once `return_response: true` is set; it's `null` for services that don't return data.

Without `return_response`, the result is just `{ context }`.

Services that return responses: `weather.get_forecasts`, `calendar.get_events`, `conversation.process`, `script` actions that explicitly return data, etc. Sending `return_response: true` to a service that doesn't support it is an error.

#### `get_states`

```json
{ "id": 19, "type": "get_states" }
```

Returns array of `{ entity_id, state, attributes, last_changed, last_updated, context }`.

#### `get_services`

```json
{ "id": 19, "type": "get_services" }
```

Returns `{ <domain>: { <service>: { name, description, fields: { <field>: { description, example, selector, ... } }, target?, response? } } }`.

`response` field is present when the service supports `return_response`. Its shape: `{ optional?: bool }`.

#### `get_config`

```json
{ "id": 19, "type": "get_config" }
```

Returns `{ latitude, longitude, elevation, unit_system, location_name, time_zone, components, version, ... }`.

#### `get_panels`

```json
{ "id": 19, "type": "get_panels" }
```

#### `subscribe_events` / `unsubscribe_events`

```json
{ "id": 18, "type": "subscribe_events", "event_type": "state_changed" }
{ "id": 19, "type": "unsubscribe_events", "subscription": 18 }
```

#### `subscribe_trigger`

```json
{
  "id": 2, "type": "subscribe_trigger",
  "trigger": { "platform": "state", "entity_id": "binary_sensor.motion_occupancy", "from": "off", "to": "on" }
}
```

#### `fire_event`

```json
{ "id": 24, "type": "fire_event", "event_type": "mydomain_event", "event_data": { ... } }
```

#### `homeassistant/expose_entity` / `homeassistant/expose_entity/list`

```json
{ "id": 18, "type": "homeassistant/expose_entity/list" }
{ "id": 19, "type": "homeassistant/expose_entity", "assistants": ["conversation"], "entity_ids": ["light.living_room"], "should_expose": true }
```

#### History — `history/history_during_period`

Not in the developer-docs page above, but observed in HA frontend traffic. Used by `ha-client.ts` today. Shape:

```json
{
  "id": N, "type": "history/history_during_period",
  "start_time": "2026-05-01T00:00:00+00:00",
  "end_time": "2026-05-02T00:00:00+00:00",
  "entity_ids": ["sensor.office_temperature"],
  "minimal_response": true,
  "no_attributes": true,
  "significant_changes_only": false
}
```

Result is keyed by entity_id: `{ "sensor.office_temperature": [{ "s": "21.5", "lu": 1714521600.0, ... }, ...] }`. Note the **abbreviated keys**: `s` (state), `lu` (last_updated, epoch seconds), `lc` (last_changed), `a` (attributes). Older HA versions may return `state` / `last_changed` / `last_updated` (full names). Parsers must handle both.

#### Other useful ones (not in the dev-docs index page)

- `config/area_registry/list`, `config/device_registry/list`, `config/entity_registry/list`, `config/floor_registry/list`
- `config/entity_registry/list_for_display` — abbreviated keys (`ei`, `pl`, `ai`, `lb`, `di`, `ic`, `tk`, `ec`, `hb`, `hn`, `en`, `dp`)
- `render_template`
- `logbook/get_events`
- `search/related`
- `repairs/list_issues`

### Ping/pong

```json
{ "id": 19, "type": "ping" }   // server replies { "type": "pong", "id": 19 }
```

### Heads-up

- The first message after auth can be `{ "type": "supported_features", "features": { "coalesce_messages": 1 } }` to get bulk message delivery.
- Error code `unknown_service` happens if you call a service with the wrong name or wrong domain.
- `return_response: true` against a service without response support → error code `service_validation_error`.

## REST API

Base: `http://<host>:8123/api/`. Auth: `Authorization: Bearer <long-lived-token>`. JSON in/out.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/` | `{ "message": "API running." }` |
| GET | `/api/config` | Same shape as WS `get_config` |
| GET | `/api/components` | Array of loaded component names |
| GET | `/api/events` | `[{ event, listener_count }]` |
| GET | `/api/services` | Same as WS `get_services` |
| GET | `/api/states` | Array of states |
| GET | `/api/states/{entity_id}` | Single state, 404 if missing |
| POST | `/api/states/{entity_id}` | `{ state, attributes }`. Sets state in HA only — does **not** talk to the device. Use service calls for that. |
| POST | `/api/services/{domain}/{service}` | Body is service_data; `?return_response` query flag for response data |
| POST | `/api/events/{event_type}` | Body is event_data |
| POST | `/api/template` | `{ "template": "..." }` → rendered text |
| POST | `/api/config/core/check_config` | `{ errors, result: "valid"\|"invalid" }` |
| POST | `/api/intent/handle` | `{ name, data }` |
| GET | `/api/history/period/{ts?}` | Query: `filter_entity_id` (required, csv), `end_time`, `minimal_response`, `no_attributes`, `significant_changes_only` |
| GET | `/api/logbook/{ts?}` | Query: `entity`, `end_time` |
| GET | `/api/error_log` | Plaintext |
| GET | `/api/calendars` | List of calendar entities |
| GET | `/api/calendars/{entity_id}?start=<ts>&end=<ts>` | Events between range |
| GET | `/api/camera_proxy/{entity_id}` | Image data; `?time=<ts>` for snapshot |
| DELETE | `/api/states/{entity_id}` | Removes the state |

### REST gotchas

- `/api/` requires the trailing slash.
- Service call return values: only with `?return_response` and only on services that support it; otherwise 400.
- No documented rate limits.

## Domain-specific notes

### Weather (`weather.*`)

- Forecast is **not on the entity**. The state has current conditions only (temperature, humidity, wind, etc.).
- Get forecast via service call:

  ```json
  {
    "type": "call_service",
    "domain": "weather",
    "service": "get_forecasts",
    "target": { "entity_id": "weather.forecast_home" },
    "service_data": { "type": "daily" },   // or "hourly", "twice_daily"
    "return_response": true
  }
  ```

  Response (in `result.response`):

  ```json
  {
    "weather.forecast_home": {
      "forecast": [
        { "datetime": "...", "condition": "...", "temperature": ..., "templow": ..., "precipitation": ..., ... }
      ]
    }
  }
  ```

- Old `weather.get_forecast` (singular) was deprecated in HA 2024.4 and removed shortly after. Always use `get_forecasts`.

### Calendar (`calendar.*`)

- Use `calendar.get_events` service with `return_response: true`, args `start_date_time`, `end_date_time`, `duration`.
- Response shape: `{ <entity_id>: { events: [{ start, end, summary, description, location }] } }`.
