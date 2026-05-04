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
import { ensureCollapsibleRenderer, registerHAToolRenderers } from "./HAToolRenderer";
import { registerChartRenderer } from "./ChartRenderer";
import { registerCameraRenderer } from "./CameraRenderer";
import { buildTopbar } from "./Topbar";
import { buildSidebar } from "./Sidebar";
import { openModelPickerDialog } from "./ModelPickerDialog";

registerHAToolRenderers();
registerChartRenderer();
registerCameraRenderer();

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

const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
const agent = new WebSocketRemoteAgent(wsUrl);

// Tools we don't have a bespoke widget for get a generic collapsed renderer.
// Catch them both from the snapshot's tool list (covers the steady state) and
// from tool execution events (covers anything new the agent surfaces mid-turn).
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

const app = document.getElementById("app")!;
app.style.display = "flex";
app.style.flexDirection = "column";
app.style.height = "100vh";

const sidebar = buildSidebar(agent);

const topbar = buildTopbar(agent, sidebar.toggle);
app.appendChild(topbar);

const layout = document.createElement("div");
layout.style.cssText = "flex: 1; min-height: 0; display: flex; overflow: hidden;";
layout.appendChild(sidebar.root);

const chatWrap = document.createElement("div");
chatWrap.style.cssText = "flex: 1; min-width: 0; min-height: 0;";
chatWrap.appendChild(chatPanel);
layout.appendChild(chatWrap);

app.appendChild(layout);
