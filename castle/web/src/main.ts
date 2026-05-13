import "./app.css";
// Importing ThemeToggle has the side-effect of applying the saved/system theme to <html>
// and registering the <theme-toggle> custom element. Default is "system" (auto), which
// is what the roadmap calls for and also makes the chart's dark-mode auto-detect line up
// with the rest of the app.
import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import {
  AppStorage,
  ChatPanel,
  CustomProvidersStore,
  IndexedDBStorageBackend,
  ProviderKeysStore,
  SessionsStore,
  SettingsStore,
  setAppStorage,
} from "@mariozechner/pi-web-ui";
import { WebSocketRemoteAgent } from "./WebSocketRemoteAgent";
import { withBase } from "./base";
import { ensureCollapsibleRenderer, registerHAToolRenderers, registerHistoryRenderers } from "./HAToolRenderer";
import { registerChartRenderer } from "./ChartRenderer";
import { registerCameraRenderer } from "./CameraRenderer";
import { buildDashboard } from "./Dashboard";
import { openModelPickerDialog } from "./ModelPickerDialog";
import { buildShell } from "./Shell";
import { entityCache } from "./EntityStateCache";
import { recentEntitiesStore } from "./RecentEntitiesStore";

registerHAToolRenderers();
registerChartRenderer();

const settings = new SettingsStore();
const providerKeys = new ProviderKeysStore();
const sessions = new SessionsStore();
const customProviders = new CustomProvidersStore();

const backend = new IndexedDBStorageBackend({
  dbName: "castle-web",
  version: 1,
  stores: [
    settings.getConfig(),
    providerKeys.getConfig(),
    customProviders.getConfig(),
    sessions.getConfig(),
    SessionsStore.getMetadataConfig(),
  ],
});

settings.setBackend(backend);
providerKeys.setBackend(backend);
customProviders.setBackend(backend);
sessions.setBackend(backend);

setAppStorage(new AppStorage(settings, providerKeys, sessions, customProviders, backend));

// Pre-seed dummy api key so AgentInterface.sendMessage doesn't prompt for one.
// Real LLM calls happen on the server, not in the browser.
await providerKeys.set("local", "remote");

const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${withBase("/ws")}`;
const agent = new WebSocketRemoteAgent(wsUrl);

// Wire the shared stores to the agent before any consumer subscribes — each
// reads from a single stream of WS frames.
entityCache.attachToAgent(agent);
recentEntitiesStore.attachToAgent(agent);

// Now safe to register the camera/present-card renderer — it needs the
// cache + the agent (for ha_call_service via /ws service_call).
registerCameraRenderer({ agent, cache: entityCache });

// Replace the compact renderer for ha_list_*_versions with the version-table
// renderer that ships a Rollback button per row. Registered after the agent
// so the button can dispatch prompts through it.
registerHistoryRenderers(agent);

// Tools we don't have a bespoke widget for get a generic collapsed renderer.
agent.subscribe((event) => {
  if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
    ensureCollapsibleRenderer(event.toolName);
  }
});
const originalApplySnapshot = agent.applySnapshot.bind(agent);
agent.applySnapshot = (snap: any) => {
  originalApplySnapshot(snap);
  if (Array.isArray(snap?.tools)) {
    for (const t of snap.tools) {
      if (t?.name) ensureCollapsibleRenderer(t.name);
    }
  }
};

const chatPanel = new ChatPanel();
await chatPanel.setAgent(agent as any, {
  onApiKeyRequired: async () => true,
  // Replace pi-web-ui's built-in cloud model picker with our /v1/models-driven
  // one. The cloud picker would list providers we can't actually call (the
  // server picks the LLM endpoint, browser just displays what's available)
  // and would mislead the user into thinking they can switch to e.g. GPT-4.
  onModelSelect: () => openModelPickerDialog(agent),
});

const dashboard = buildDashboard(agent);

const app = document.getElementById("app")!;
app.style.cssText = "display: flex; flex-direction: column; height: 100vh; height: 100dvh;";
app.appendChild(buildShell({ agent, chatPanel, dashboard }));
