// Resolved on-disk locations for Castle's persistent state. By default
// everything lives in `.pi-agent/` next to the source files — convenient for
// dev. The Home Assistant add-on sets `CASTLE_DATA_DIR=/data` so persistence
// survives container rebuilds (Supervisor maps that path to a managed volume).

const CWD_DIR = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const OVERRIDE = (Deno.env.get("CASTLE_DATA_DIR") ?? "").trim();

export const DATA_DIR = OVERRIDE || `${CWD_DIR}/.pi-agent`;
export const SOURCE_DIR = CWD_DIR;

// Ensure the data dir exists before any consumer tries to read/write inside
// it. Synchronous because module init must finish before settings/catalog/etc.
// touch the filesystem; mkdirSync with `recursive` is a no-op when present.
try {
  Deno.mkdirSync(DATA_DIR, { recursive: true });
} catch (err) {
  if (!(err instanceof Deno.errors.AlreadyExists)) throw err;
}

