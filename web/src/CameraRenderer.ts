import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { type ToolRenderer, type ToolRenderResult, registerToolRenderer, renderHeader } from "@mariozechner/pi-web-ui";
import { getDuration } from "./ToolDurations";
import { summaryWithDuration } from "./ToolHeader";
import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { Camera, Video } from "lucide";

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

class ShowCameraRenderer implements ToolRenderer {
  render(rawArgs: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
    return renderCameraTool({
      rawArgs, result, isStreaming,
      headerLabel: "Live",
      icon: Video,
      build: (args, el) => buildLiveFeed(args, el),
    });
  }
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

export function registerCameraRenderer(): void {
  registerToolRenderer("ha_show_camera", new ShowCameraRenderer());
  registerToolRenderer("ha_get_camera_snapshot", new GetCameraSnapshotRenderer());
}
