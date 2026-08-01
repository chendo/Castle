// Boot-time installer for the Home Assistant Assist bridge.
//
// Castle is a Supervisor add-on (a container); the conversation agent must be a
// Home Assistant *integration* (Python loaded by Core from its config dir). An
// add-on can't register an entity, but with the `homeassistant_config` map it
// can write into Core's config dir — so on boot we copy the bundled
// `castle_conversation` custom integration into /homeassistant/custom_components/.
//
// Core only scans custom_components at startup, so a freshly-copied integration
// needs one Home Assistant restart before it appears. We copy only when the
// bundled version differs from what's already installed to avoid churn.
import { copy } from "jsr:@std/fs@1/copy";

const HA_CONFIG_DIR = "/homeassistant";
const COMPONENT = "castle_conversation";
const SOURCE_DIR = new URL(`custom_components/${COMPONENT}/`, import.meta.url).pathname;

async function readManifestVersion(dir: string): Promise<string | null> {
  try {
    const raw = await Deno.readTextFile(`${dir}/manifest.json`);
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/**
 * Copy the bundled conversation integration into Home Assistant's config dir if
 * Supervisor mapped it (the `homeassistant_config` map) and the installed copy
 * is missing or stale. No-op (and silent) when the map isn't present, i.e. when
 * running standalone or in dev — there's no Core config dir to install into.
 */
export async function installBridgeComponent(): Promise<void> {
  try {
    const stat = await Deno.stat(HA_CONFIG_DIR);
    if (!stat.isDirectory) return;
  } catch {
    return; // /homeassistant not mapped — standalone/dev, nothing to do.
  }

  const bundledVersion = await readManifestVersion(SOURCE_DIR);
  if (!bundledVersion) {
    console.warn("[bridge] bundled integration missing or has no version; skipping install");
    return;
  }

  const dest = `${HA_CONFIG_DIR}/custom_components/${COMPONENT}`;
  const installedVersion = await readManifestVersion(dest);
  if (installedVersion === bundledVersion) return; // already current.

  try {
    await Deno.mkdir(`${HA_CONFIG_DIR}/custom_components`, { recursive: true });
    await copy(SOURCE_DIR, dest, { overwrite: true });
    const verb = installedVersion ? `updated ${installedVersion} → ${bundledVersion}` : `installed ${bundledVersion}`;
    console.log(
      `[bridge] castle_conversation ${verb} in ${dest} — ` +
        `restart Home Assistant to load it, then add the "Castle" integration.`,
    );
  } catch (err) {
    console.error(`[bridge] failed to install conversation integration: ${(err as Error).message}`);
  }
}
