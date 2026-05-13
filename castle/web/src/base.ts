// Path prefix where the app is being served. Empty string for a plain
// deploy at root; something like "/api/hassio_ingress/<token>" when the
// add-on is loaded inside Home Assistant's Supervisor ingress iframe.
//
// HA ingress proxies `/api/hassio_ingress/<token>/foo` → `/foo` on the
// add-on, so the server sees clean paths but the browser's location.pathname
// carries the prefix. Every absolute URL the frontend builds (WS, fetch,
// window.open) and every route the SPA pushes/parses has to honour this.

function detect(): string {
  const m = /^(\/api\/hassio_ingress\/[^/]+)\//.exec(location.pathname);
  return m ? m[1] : "";
}

export const BASE = detect();

/** Prefix an absolute app-internal path with BASE. Pass-through when BASE is empty. */
export function withBase(path: string): string {
  if (!path.startsWith("/")) return path;
  return BASE + path;
}

/** Strip BASE from a location pathname so the SPA router can match against raw routes. */
export function stripBase(pathname: string): string {
  if (!BASE) return pathname;
  if (pathname === BASE) return "/";
  if (pathname.startsWith(BASE + "/")) return pathname.slice(BASE.length);
  return pathname;
}
