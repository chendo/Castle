import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { getToolRenderer, type ToolRenderer, type ToolRenderResult, registerToolRenderer, renderHeader } from "@mariozechner/pi-web-ui";
import { getDuration } from "./ToolDurations";
import { summaryWithDuration } from "./ToolHeader";
import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { Camera, Video } from "lucide";
import { buildEntityCard, type CardDeps } from "./EntityCard";

interface CameraArgs {
  entity_id: string;
  title?: string;
}

function parseArgs(raw: unknown): CameraArgs | null {
  let parsed: any = raw;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  if (!parsed?.entity_id || typeof parsed.entity_id !== "string") return null;
  if (!parsed.entity_id.startsWith("camera.")) return null;
  return parsed as CameraArgs;
}

function buildSnapshot(args: CameraArgs, container: HTMLElement, captureTs?: number): void {
  const img = document.createElement("img");
  // Cache-bust with the *capture* timestamp (when the tool ran) so the image
  // shown in the UI lines up with what the agent saw, not whatever the camera
  // happens to return now if the user re-renders the chat later.
  img.src = `/camera/${encodeURIComponent(args.entity_id)}?ts=${captureTs ?? Date.now()}`;
  img.alt = args.entity_id;
  img.style.cssText = "max-width: 100%; border-radius: 8px; display: block; background: var(--muted);";
  img.onerror = () => {
    container.innerHTML = `<div style="font-size:12px;color:var(--destructive);">Snapshot unavailable for ${args.entity_id}</div>`;
  };
  container.appendChild(img);
}

// Inject the pulse keyframes once.
function ensurePulseStyle(): void {
  if (document.getElementById("castle-pulse-style")) return;
  const style = document.createElement("style");
  style.id = "castle-pulse-style";
  style.textContent = "@keyframes castle-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }";
  document.head.appendChild(style);
}

/**
 * Custom element wrapping the MJPEG live feed. Replaces an earlier hand-rolled
 * teardown via a `MutationObserver` on `document.body` — that observer fired
 * on every DOM mutation in the entire app per camera widget, which compounded
 * with pi-web-ui's per-token chat re-renders into a steady CPU floor and held
 * the wrap (+ its observers/listeners) in memory after Lit detached the widget.
 *
 * connectedCallback / disconnectedCallback give us the lifecycle for free —
 * no global observer required.
 */
class CastleLiveCamera extends HTMLElement {
  private wrap?: HTMLDivElement;
  private img?: HTMLImageElement;
  private badge?: HTMLDivElement;
  private intersectionObserver?: IntersectionObserver;
  private onVisibility?: () => void;
  private isLive = false;
  private streamUrl = "";
  private entityId = "";

  connectedCallback(): void {
    if (this.wrap) return; // already initialised; reuse on re-attach
    this.entityId = this.getAttribute("entity-id") ?? "";
    if (!this.entityId) return;
    this.streamUrl = `/camera_stream/${encodeURIComponent(this.entityId)}`;
    ensurePulseStyle();

    this.wrap = document.createElement("div");
    this.wrap.style.cssText = "position: relative; border-radius: 8px; overflow: hidden; background: var(--muted);";

    this.img = document.createElement("img");
    this.img.alt = this.entityId;
    this.img.style.cssText = "width: 100%; display: block;";
    this.img.onerror = () => {
      if (this.wrap) this.wrap.innerHTML = `<div style="font-size:12px;color:var(--destructive);">Live feed unavailable for ${this.entityId}</div>`;
    };

    this.badge = document.createElement("div");
    this.badge.style.cssText = `
      position: absolute; top: 8px; left: 8px;
      padding: 2px 8px; border-radius: 4px;
      font-size: 11px; font-weight: 500;
      color: white; pointer-events: none;
      display: flex; align-items: center; gap: 4px;
    `;

    this.wrap.append(this.img, this.badge);
    this.appendChild(this.wrap);
    this.renderBadge(false);

    this.intersectionObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting && !document.hidden) this.start();
        else this.stop();
      }
    }, { threshold: 0.1 });
    this.intersectionObserver.observe(this.wrap);

    this.onVisibility = () => {
      if (!this.wrap) return;
      if (document.hidden) this.stop();
      else if (this.wrap.getBoundingClientRect().top < innerHeight && this.wrap.getBoundingClientRect().bottom > 0) this.start();
    };
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  disconnectedCallback(): void {
    this.stop();
    this.intersectionObserver?.disconnect();
    this.intersectionObserver = undefined;
    if (this.onVisibility) {
      document.removeEventListener("visibilitychange", this.onVisibility);
      this.onVisibility = undefined;
    }
  }

  private start(): void {
    if (this.isLive || !this.img) return;
    this.img.src = this.streamUrl + `?ts=${Date.now()}`;
    this.isLive = true;
    this.renderBadge(true);
  }

  private stop(): void {
    if (!this.isLive || !this.img) return;
    this.img.src = ""; // detaching the src halts the MJPEG connection
    this.isLive = false;
    this.renderBadge(false);
  }

  private renderBadge(live: boolean): void {
    if (!this.badge) return;
    if (live) {
      this.badge.style.background = "rgba(220, 38, 38, 0.85)";
      this.badge.innerHTML = `<span style="width:6px;height:6px;border-radius:50%;background:white;display:inline-block;animation:castle-pulse 1.4s infinite;"></span>LIVE`;
    } else {
      this.badge.style.background = "rgba(0,0,0,0.6)";
      this.badge.textContent = "PAUSED";
    }
  }
}

if (!customElements.get("castle-live-camera")) {
  customElements.define("castle-live-camera", CastleLiveCamera);
}

function buildLiveFeed(args: CameraArgs, container: HTMLElement): void {
  const el = document.createElement("castle-live-camera");
  el.setAttribute("entity-id", args.entity_id);
  container.appendChild(el);
}

/**
 * Shared renderer scaffolding for both camera tools. Differs only in the
 * header label/icon and the body builder.
 */
function renderCameraTool(opts: {
  rawArgs: any;
  result: ToolResultMessage | undefined;
  isStreaming: boolean | undefined;
  headerLabel: "Live" | "Snapshot";
  icon: typeof Camera;
  build: (args: CameraArgs, el: HTMLElement, captureTs?: number) => void;
}): ToolRenderResult {
  const args = parseArgs(opts.rawArgs);
  const state: "inprogress" | "complete" | "error" = opts.result
    ? (opts.result.isError ? "error" : "complete")
    : opts.isStreaming ? "inprogress" : "complete";

  const summary = (() => {
    if (!args) return opts.headerLabel.toLowerCase();
    const head = `${opts.headerLabel}: ${args.entity_id}`;
    const withTitle = args.title ? `${head} — ${args.title}` : head;
    const durationMs = opts.result?.toolCallId ? getDuration(opts.result.toolCallId) : undefined;
    return summaryWithDuration(withTitle, durationMs);
  })();

  const container = createRef<HTMLDivElement>();
  // Capture timestamp for snapshot cache-busting — taken at first render so it
  // stays stable across re-renders and reflects when this tool result landed.
  const captureTs = opts.result ? Date.now() : undefined;

  if (args && (opts.result || !opts.isStreaming)) {
    queueMicrotask(() => {
      const el = container.value;
      if (!el || el.dataset.rendered === "1") return;
      el.dataset.rendered = "1";
      el.innerHTML = "";
      if (args.title) {
        const t = document.createElement("div");
        t.style.cssText = "font-size: 13px; font-weight: 500; margin-bottom: 6px; color: var(--foreground);";
        t.textContent = args.title;
        el.appendChild(t);
      }
      opts.build(args, el, captureTs);
    });
  }

  return {
    content: html`
      <div>
        ${renderHeader(state, opts.icon, summary)}
        <div ${ref(container)} style="margin-top: 8px;"></div>
      </div>
    `,
    isCustom: false,
  };
}

class GetCameraSnapshotRenderer implements ToolRenderer {
  render(rawArgs: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
    return renderCameraTool({
      rawArgs, result, isStreaming,
      headerLabel: "Snapshot",
      icon: Camera,
      build: (args, el, ts) => buildSnapshot(args, el, ts),
    });
  }
}

interface PresentCard {
  entity_id: string;
  kind: string;   // "camera" | "entity" | "fallback"
  domain: string;
}

/** Dispatcher renderer for `ha_present_card`. The server's tool result
 *  carries a `details.cards: PresentCard[]` array describing which kind of
 *  widget to render per entity. Cameras get the live-feed builder; every
 *  other kind goes through buildEntityCard, which renders a domain-tailored
 *  interactive card (toggles for switches, sliders for lights, target-temp
 *  controls for climate, etc.) and live-updates from the entity state cache. */
class PresentCardRenderer implements ToolRenderer {
  constructor(private readonly deps: CardDeps) {}

  render(rawArgs: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
    const argsObj = (() => {
      let p: any = rawArgs;
      if (typeof p === "string") {
        try { p = JSON.parse(p); } catch { return null; }
      }
      return p && typeof p === "object" ? p : null;
    })();
    const titleArg = typeof argsObj?.title === "string" ? argsObj.title : undefined;
    // Prefer the cards array the server attached to result.details. Fall
    // back to deriving it from rawArgs.entity_ids if the result hasn't
    // landed yet (streaming) or is malformed. Defensive because we want
    // the live-render path to start drawing as early as possible.
    const detailsCards = (result?.details as any)?.cards as PresentCard[] | undefined;
    const cards: PresentCard[] = (() => {
      if (Array.isArray(detailsCards) && detailsCards.length > 0) return detailsCards;
      const ids = Array.isArray(argsObj?.entity_ids) ? argsObj.entity_ids as unknown[] : [];
      return ids
        .filter((id): id is string => typeof id === "string" && id.includes("."))
        .map((id) => {
          const domain = id.slice(0, id.indexOf("."));
          return { entity_id: id, domain, kind: domain === "camera" ? "camera" : "entity" };
        });
    })();

    const state: "inprogress" | "complete" | "error" = result
      ? (result.isError ? "error" : "complete")
      : isStreaming ? "inprogress" : "complete";
    const title = titleArg ?? ((result?.details as any)?.title as string | undefined);
    const summary = (() => {
      if (cards.length === 0) return "card";
      const head = cards.length === 1
        ? `Card: ${cards[0].entity_id}`
        : `Cards: ${cards.map((c) => c.entity_id).join(", ")}`;
      const withTitle = title ? `${head} — ${title}` : head;
      const durationMs = result?.toolCallId ? getDuration(result.toolCallId) : undefined;
      return summaryWithDuration(withTitle, durationMs);
    })();

    const container = createRef<HTMLDivElement>();
    const captureTs = result ? Date.now() : undefined;

    if (cards.length > 0 && (result || !isStreaming)) {
      queueMicrotask(() => {
        const root = container.value;
        if (!root || root.dataset.rendered === "1") return;
        root.dataset.rendered = "1";
        root.innerHTML = "";
        if (title) {
          const h = document.createElement("div");
          h.style.cssText = "font-size: 13px; font-weight: 500; margin-bottom: 6px; color: var(--foreground);";
          h.textContent = title;
          root.appendChild(h);
        }
        for (const card of cards) {
          const slot = document.createElement("div");
          slot.style.cssText = "margin-bottom: 8px;";
          if (card.kind === "camera") {
            buildLiveFeed({ entity_id: card.entity_id }, slot);
          } else {
            // Domain-tailored interactive card. Live-updates from the
            // entity cache; controls fire ha_call_service via /ws.
            buildEntityCard(card, this.deps, slot);
          }
          root.appendChild(slot);
        }
      });
    }
    void captureTs; // currently unused for non-camera cards — reserved for future per-card snapshots

    return {
      content: html`
        <div>
          ${renderHeader(state, Video, summary)}
          <div ${ref(container)} style="margin-top: 8px;"></div>
        </div>
      `,
      isCustom: false,
    };
  }
}

/** Wraps the existing `ha_call_service` collapsible so an inline entity
 *  card mounts as soon as the agent's streaming params include an
 *  entity_id. The card subscribes to EntityStateCache, so the moment the
 *  service call lands and HA pushes the resulting state_changed event,
 *  the card flips on/off (or moves a slider, etc.) — visualising the
 *  control action without an extra round-trip. The actual service call
 *  is unchanged; the card render is a pure UI side-effect that runs in
 *  parallel with the LLM's tool execution. */
class ServiceCallCardRenderer implements ToolRenderer {
  constructor(
    private readonly deps: CardDeps,
    private readonly inner: ToolRenderer,
  ) {}

  render(rawArgs: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
    const innerResult = this.inner.render(rawArgs, result, isStreaming);
    const params = (() => {
      let p: any = rawArgs;
      if (typeof p === "string") {
        try { p = JSON.parse(p); } catch { return null; }
      }
      return p && typeof p === "object" ? p : null;
    })();
    const entityIds = collectEntityIds(params);
    if (entityIds.length === 0) return innerResult;

    // Stable key so we only mount the card slot once per render cycle.
    // Without this, every re-render (one per streamed event during a
    // live tool call) would tear down and rebuild the card, killing
    // the live-state subscription.
    const slotRef = createRef<HTMLDivElement>();
    queueMicrotask(() => {
      const root = slotRef.value;
      if (!root || root.dataset.rendered === "1") return;
      root.dataset.rendered = "1";
      for (const entityId of entityIds) {
        const slot = document.createElement("div");
        slot.style.cssText = "margin-top: 6px;";
        const domain = entityId.split(".")[0] ?? "";
        buildEntityCard({ entity_id: entityId, kind: "entity", domain }, this.deps, slot);
        root.appendChild(slot);
      }
    });

    return {
      content: html`
        <div>
          ${innerResult.content}
          <div ${ref(slotRef)}></div>
        </div>
      `,
      isCustom: false,
    };
  }
}

/** Pulls entity_ids out of an ha_call_service param object. HA accepts
 *  entity_id at the top level, under service_data, and under target —
 *  any of them may be a string or an array. We dedupe and skip groups
 *  / non-entity strings. */
function collectEntityIds(params: any): string[] {
  if (!params) return [];
  const candidates: unknown[] = [];
  for (const key of ["entity_id", "service_data", "target"]) {
    const v = params[key];
    if (key === "entity_id") {
      candidates.push(v);
    } else if (v && typeof v === "object") {
      candidates.push((v as any).entity_id);
    }
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const list = Array.isArray(c) ? c : c !== undefined ? [c] : [];
    for (const item of list) {
      if (typeof item !== "string") continue;
      if (!/^[a-z_][a-z0-9_]*\.[a-z0-9_]+$/i.test(item)) continue;
      if (seen.has(item)) continue;
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

export function registerCameraRenderer(deps: CardDeps): void {
  registerToolRenderer("ha_present_card", new PresentCardRenderer(deps));
  registerToolRenderer("ha_get_camera_snapshot", new GetCameraSnapshotRenderer());
  // Wrap whichever renderer is already registered for ha_call_service
  // (registerHAToolRenderers runs before this in main.ts) so we keep its
  // collapsible header verbatim and just prepend a live entity card.
  const existing = getToolRenderer("ha_call_service");
  if (existing) {
    registerToolRenderer("ha_call_service", new ServiceCallCardRenderer(deps, existing));
  }
}
