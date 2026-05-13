// scripts/ws.ts — generic Home Assistant websocket poking tool.
//
// Connects to HA, authenticates, sends a JSON command, prints every response
// frame for `--wait` seconds (default 5), then disconnects. Useful for
// inspecting API shape / behaviour from a shell or letting the agent probe
// undocumented endpoints during development.
//
// Usage:
//   docker compose exec castledeno run --allow-all scripts/ws.ts \
//     --type get_states
//
//   docker compose exec castledeno run --allow-all scripts/ws.ts \
//     --type 'config/area_registry/list'
//
//   # Send a command with extra fields by passing JSON via --data.
//   docker compose exec castledeno run --allow-all scripts/ws.ts \
//     --type trace/list --data '{"domain":"automation","item_id":"123"}'
//
//   # Or pipe a complete JSON command on stdin (--type omitted):
//   echo '{"type":"get_services"}' | docker compose exec -T castle \
//     deno run --allow-all scripts/ws.ts --stdin
//
// HA_URL and HA_TOKEN come from the environment (already set in the castle
// container). Output is the raw JSON of every response frame, one per line,
// pretty-printed.

interface ParsedArgs {
  type?: string;
  data?: string;
  wait: number;
  stdin: boolean;
  raw: boolean;
}

function parseArgv(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { wait: 5, stdin: false, raw: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--type") out.type = argv[++i];
    else if (a === "--data") out.data = argv[++i];
    else if (a === "--wait") out.wait = Number(argv[++i]);
    else if (a === "--stdin") out.stdin = true;
    else if (a === "--raw") out.raw = true;
    else if (a === "-h" || a === "--help") {
      console.log(`Usage: deno run --allow-all scripts/ws.ts [options]
  --type <name>      WS command type (e.g. get_states, trace/list)
  --data <json>      Extra fields merged into the command, as JSON
  --stdin            Read the full JSON command from stdin (overrides --type/--data)
  --wait <seconds>   How long to listen for responses after sending. Default 5.
  --raw              Print frames verbatim (no pretty-printing).`);
      Deno.exit(0);
    }
  }
  return out;
}

async function readStdin(): Promise<string> {
  const decoder = new TextDecoder();
  let acc = "";
  const buf = new Uint8Array(4096);
  while (true) {
    const n = await Deno.stdin.read(buf);
    if (n === null) break;
    acc += decoder.decode(buf.subarray(0, n));
  }
  return acc;
}

const args = parseArgv(Deno.args);

const HA_URL = Deno.env.get("HA_URL") ?? "http://homeassistant.local:8123";
const HA_TOKEN = Deno.env.get("HA_TOKEN") ?? "";
if (!HA_TOKEN) {
  console.error("HA_TOKEN env var required");
  Deno.exit(2);
}

// Resolve the command payload before opening the socket so we can fail fast
// on bad JSON without leaving a dangling connection.
let command: Record<string, unknown>;
if (args.stdin) {
  const text = (await readStdin()).trim();
  if (!text) {
    console.error("--stdin given but no data on stdin");
    Deno.exit(2);
  }
  try { command = JSON.parse(text); } catch (err) {
    console.error(`stdin is not valid JSON: ${(err as Error).message}`);
    Deno.exit(2);
  }
} else {
  if (!args.type) {
    console.error("Either --type or --stdin is required (use --help for usage)");
    Deno.exit(2);
  }
  command = { type: args.type };
  if (args.data) {
    try {
      Object.assign(command, JSON.parse(args.data));
    } catch (err) {
      console.error(`--data is not valid JSON: ${(err as Error).message}`);
      Deno.exit(2);
    }
  }
}

const wsUrl = HA_URL.replace(/^http/, "ws").replace(/\/$/, "") + "/api/websocket";
const ws = new WebSocket(wsUrl);

const seenMyResponse = { value: false };

function printFrame(frame: unknown): void {
  if (args.raw) {
    console.log(JSON.stringify(frame));
  } else {
    console.log(JSON.stringify(frame, null, 2));
  }
}

const COMMAND_ID = 100; // Stable id so callers can grep for "id":100 in output.

ws.onopen = () => {
  // The auth handshake is driven by HA: it sends auth_required first.
};

ws.onmessage = (ev) => {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
  } catch {
    console.error(`(non-JSON frame ignored: ${ev.data})`);
    return;
  }
  switch (msg.type) {
    case "auth_required":
      ws.send(JSON.stringify({ type: "auth", access_token: HA_TOKEN }));
      return;
    case "auth_ok":
      ws.send(JSON.stringify({ ...command, id: COMMAND_ID }));
      console.error(`> sent ${JSON.stringify({ ...command, id: COMMAND_ID })}`);
      return;
    case "auth_invalid":
      console.error(`auth failed: ${msg.message}`);
      Deno.exit(1);
  }
  if ((msg as { id?: number }).id === COMMAND_ID) {
    seenMyResponse.value = true;
  }
  printFrame(msg);
};

ws.onerror = (err) => {
  console.error("websocket error", err);
};

ws.onclose = (ev) => {
  if (!ev.wasClean) console.error(`socket closed (code=${ev.code} reason=${ev.reason})`);
};

// Listen for `wait` seconds, then close. If we never saw a response to our
// command, exit non-zero so scripted callers can detect the failure.
setTimeout(() => {
  ws.close();
  if (!seenMyResponse.value) {
    console.error(`(no response to id=${COMMAND_ID} within ${args.wait}s)`);
    Deno.exit(3);
  }
  Deno.exit(0);
}, args.wait * 1000);
