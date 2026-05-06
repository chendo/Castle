#!/usr/bin/env -S deno run --allow-net --allow-env
// Create a storage-mode lovelace dashboard via the HA WebSocket API so the
// integration suite has something for ha_edit_dashboard / lovelace tests to
// mutate. HA only accepts `mode: yaml` dashboards in configuration.yaml, and
// the auto-generated "Overview" never shows up in lovelace/dashboards/list.
//
// Idempotent: if a dashboard with url_path "main-dashboard" already exists,
// we skip the create call. Designed to run once per fresh ha-demo onboarding.

const HA_URL = Deno.env.get("HA_URL") ?? "http://localhost:8123";
const HA_TOKEN = Deno.env.get("HA_TOKEN") ?? "";
if (!HA_TOKEN) {
  console.error("seed-test-dashboard: HA_TOKEN env var is required");
  Deno.exit(1);
}

const wsUrl = HA_URL.replace(/^http(s?):\/\//, "ws$1://").replace(/\/$/, "") + "/api/websocket";

function call<T>(ws: WebSocket, msg: Record<string, unknown>, id: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const onmsg = (ev: MessageEvent) => {
      const m = JSON.parse(ev.data as string) as { id?: number; success?: boolean; result?: T; error?: { message?: string } };
      if (m.id !== id) return;
      ws.removeEventListener("message", onmsg);
      if (m.success) resolve(m.result as T);
      else reject(new Error(m.error?.message ?? "unknown ws error"));
    };
    ws.addEventListener("message", onmsg);
    ws.send(JSON.stringify({ id, ...msg }));
  });
}

const ws = new WebSocket(wsUrl);
await new Promise<void>((resolve, reject) => {
  ws.onopen = () => resolve();
  ws.onerror = () => reject(new Error("ws connect failed"));
});

// Auth handshake.
await new Promise<void>((resolve, reject) => {
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data as string);
    if (m.type === "auth_required") ws.send(JSON.stringify({ type: "auth", access_token: HA_TOKEN }));
    else if (m.type === "auth_ok") resolve();
    else if (m.type === "auth_invalid") reject(new Error("ws auth invalid"));
  };
});

const existing = await call<Array<{ url_path: string; title: string }>>(ws, { type: "lovelace/dashboards/list" }, 1);
if (existing.some((d) => d.url_path === "main-dashboard")) {
  console.log("seed-test-dashboard: main-dashboard already exists, skipping create.");
} else {
  const created = await call<{ url_path: string; title: string }>(ws, {
    type: "lovelace/dashboards/create",
    url_path: "main-dashboard",
    title: "Main Dashboard",
    icon: "mdi:home",
    show_in_sidebar: true,
    require_admin: false,
    mode: "storage",
  }, 2);
  console.log(`seed-test-dashboard: created ${created.url_path} ("${created.title}").`);

  // Seed a non-empty initial config so dashboard mutation tests can compare
  // before/after YAML and see real diffs. One blank view with no cards.
  await call(ws, {
    type: "lovelace/config/save",
    url_path: "main-dashboard",
    config: { views: [{ title: "Home", path: "default", cards: [] }] },
  }, 3);
}

ws.close();
