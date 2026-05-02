import "./app.css";
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
import { registerHAToolRenderers } from "./HAToolRenderer";
import { registerChartRenderer } from "./ChartRenderer";
import { registerCameraRenderer } from "./CameraRenderer";
import { buildTopbar } from "./Topbar";
import { buildSidebar } from "./Sidebar";
import { createVoiceController } from "./VoiceController";

registerHAToolRenderers();
registerChartRenderer();
registerCameraRenderer();

const settings = new SettingsStore();
const providerKeys = new ProviderKeysStore();
const sessions = new SessionsStore();
const customProviders = new CustomProvidersStore();

const backend = new IndexedDBStorageBackend({
  dbName: "hai-web",
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
await providerKeys.set("lmstudio", "remote");

const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
const agent = new WebSocketRemoteAgent(wsUrl);

const chatPanel = new ChatPanel();
await chatPanel.setAgent(agent as any, {
  onApiKeyRequired: async () => true,
});

const app = document.getElementById("app")!;
app.style.display = "flex";
app.style.flexDirection = "column";
app.style.height = "100vh";

const sidebar = buildSidebar();
const voice = createVoiceController(agent, chatPanel);

const topbar = buildTopbar(agent, sidebar.toggle, voice);
app.appendChild(topbar);

const layout = document.createElement("div");
layout.style.cssText = "flex: 1; min-height: 0; display: flex; overflow: hidden;";
layout.appendChild(sidebar.root);

const chatWrap = document.createElement("div");
chatWrap.style.cssText = "flex: 1; min-width: 0; min-height: 0;";
chatWrap.appendChild(chatPanel);
layout.appendChild(chatWrap);

app.appendChild(layout);
