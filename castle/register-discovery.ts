// Registers Castle with the Home Assistant Supervisor discovery service so the
// castle_conversation integration auto-prompts setup — no manual "Add
// integration" + URL typing. Supervisor routes the discovery message to the
// integration's `async_step_hassio` with the `{url, token}` config below.
//
// The internal URL is authoritative: it comes from the add-on's own Supervisor
// info (`hostname`), which is the DNS name Home Assistant Core uses to reach us
// on the hassio network. Requires `hassio_api: true` + a Supervisor token.
const SUPERVISOR_TOKEN = Deno.env.get("SUPERVISOR_TOKEN") ?? Deno.env.get("HASSIO_TOKEN") ?? "";
const SUPERVISOR_API = "http://supervisor";
const DISCOVERY_SERVICE = "castle_conversation";

// deno-lint-ignore no-explicit-any
async function supervisor(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${SUPERVISOR_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${SUPERVISOR_TOKEN}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message ?? `supervisor ${path} → ${res.status}`);
  return data?.data ?? data;
}

/**
 * Advertise Castle to Supervisor so Home Assistant surfaces a "discovered:
 * Castle — Configure?" card pre-filled with the add-on's reachable URL. No-op
 * when not running under Supervisor. Skips if an equivalent message is already
 * published so restarts don't pile up duplicates (the config flow would abort
 * them anyway via its unique_id, but a clean discovery list is nicer).
 */
export async function registerHassioDiscovery(authToken: string, port: number): Promise<void> {
  if (!SUPERVISOR_TOKEN) return; // standalone / dev — nothing to register with.
  try {
    const existing = await supervisor("/discovery");
    const messages: Array<{ service?: string }> = existing?.discovery ?? [];
    if (messages.some((m) => m.service === DISCOVERY_SERVICE)) return;

    const info = await supervisor("/addons/self/info");
    const hostname: string | undefined = info?.hostname;
    if (!hostname) {
      console.warn("[discovery] add-on hostname unavailable; skipping auto-discovery");
      return;
    }
    const url = `http://${hostname}:${port}`;

    await supervisor("/discovery", {
      method: "POST",
      body: JSON.stringify({ service: DISCOVERY_SERVICE, config: { url, token: authToken } }),
    });
    console.log(`[discovery] advertised castle_conversation to Home Assistant at ${url}`);
  } catch (err) {
    // Discovery is a convenience — the manual "Add integration" flow still
    // works, so a failure here is a warning, not a fatal boot error.
    console.warn(`[discovery] could not register with Supervisor: ${(err as Error).message}`);
  }
}
