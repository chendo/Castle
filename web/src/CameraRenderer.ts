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

function buildLiveFeed(args: CameraArgs, container: HTMLElement): void {
  const wrap = document.createElement("div");
  wrap.style.cssText = "position: relative; border-radius: 8px; overflow: hidden; background: var(--muted);";

  const img = document.createElement("img");
  img.alt = args.entity_id;
  img.style.cssText = "width: 100%; display: block;";

  // Status badge
  const badge = document.createElement("div");
  badge.style.cssText = `
    position: absolute; top: 8px; left: 8px;
    padding: 2px 8px; border-radius: 4px;
    font-size: 11px; font-weight: 500;
    color: white; pointer-events: none;
    display: flex; align-items: center; gap: 4px;
  `;
  const renderBadge = (live: boolean) => {
    if (live) {
      badge.style.background = "rgba(220, 38, 38, 0.85)";
      badge.innerHTML = `<span style="width:6px;height:6px;border-radius:50%;background:white;display:inline-block;animation:castle-pulse 1.4s infinite;"></span>LIVE`;
    } else {
      badge.style.background = "rgba(0,0,0,0.6)";
      badge.textContent = "PAUSED";
    }
  };

  // Inject the pulse keyframes once.
  if (!document.getElementById("castle-pulse-style")) {
    const style = document.createElement("style");
    style.id = "castle-pulse-style";
    style.textContent = "@keyframes castle-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }";
    document.head.appendChild(style);
  }

  img.onerror = () => {
    container.innerHTML = `<div style="font-size:12px;color:var(--destructive);">Live feed unavailable for ${args.entity_id}</div>`;
  };

  wrap.append(img, badge);
  container.appendChild(wrap);

  const streamUrl = `/camera_stream/${encodeURIComponent(args.entity_id)}`;
  let isLive = false;

  const start = () => {
    if (isLive) return;
    img.src = streamUrl + `?ts=${Date.now()}`; // cache-bust to force a fresh stream
    isLive = true;
    renderBadge(true);
  };
  const stop = () => {
    if (!isLive) return;
    img.src = ""; // detach to halt the MJPEG stream and free the connection
    isLive = false;
    renderBadge(false);
  };

  // Auto pause/resume based on viewport visibility and tab visibility.
  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting && !document.hidden) start();
      else stop();
    }
  }, { threshold: 0.1 });
  observer.observe(wrap);

  const onVisibility = () => {
    if (document.hidden) stop();
    else if (wrap.getBoundingClientRect().top < innerHeight && wrap.getBoundingClientRect().bottom > 0) start();
  };
  document.addEventListener("visibilitychange", onVisibility);

  // Stop if the chat removes the element (cleanup safety net).
  const cleanupObserver = new MutationObserver(() => {
    if (!document.body.contains(wrap)) {
      stop();
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      cleanupObserver.disconnect();
    }
  });
  cleanupObserver.observe(document.body, { childList: true, subtree: true });
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
