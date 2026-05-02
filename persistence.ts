// Lightweight conversation persistence: each conversation gets one markdown
// file under .pi-agent/conversations/<timestamp>-<slug>.md, appended to as
// messages stream. Reset → next prompt starts a new file.
//
// The intent is human-readable history that future context-builder agents can
// grep / summarize without reverse-engineering some binary session format.

const CONVERSATIONS_DIR = new URL(".pi-agent/conversations/", import.meta.url).pathname;

let currentPath: string | null = null;
let dirEnsured = false;

async function ensureDir(): Promise<void> {
  if (dirEnsured) return;
  try { await Deno.mkdir(CONVERSATIONS_DIR, { recursive: true }); } catch { /* */ }
  dirEnsured = true;
}

function slugify(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return cleaned || "conversation";
}

function timestamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function localTime(ts?: number): string {
  const d = ts ? new Date(ts) : new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// deno-lint-ignore no-explicit-any
function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      // deno-lint-ignore no-explicit-any
      .filter((c: any) => c.type === "text")
      // deno-lint-ignore no-explicit-any
      .map((c: any) => c.text ?? "")
      .join("");
  }
  return "";
}

async function append(text: string): Promise<void> {
  if (!currentPath) return;
  try {
    await Deno.writeTextFile(currentPath, text, { append: true });
  } catch (err) {
    console.warn("[persistence] append failed:", (err as Error).message);
  }
}

/** Reset the file pointer. Next user message will start a fresh file. */
export function resetConversationFile(): void {
  currentPath = null;
}

/** Start a new conversation file using `firstUserText` for the slug. */
async function startFile(firstUserText: string): Promise<void> {
  await ensureDir();
  const slug = slugify(firstUserText);
  currentPath = `${CONVERSATIONS_DIR}${timestamp()}-${slug}.md`;
  const header = `# Conversation — ${localTime()}\n\n`;
  try {
    await Deno.writeTextFile(currentPath, header);
  } catch (err) {
    console.warn("[persistence] couldn't create file:", (err as Error).message);
    currentPath = null;
  }
}

/** Append a user message. Starts a new file if none is open yet. */
// deno-lint-ignore no-explicit-any
async function logUser(m: any): Promise<void> {
  const text = extractText(m.content).trim();
  if (!text) return;
  if (!currentPath) await startFile(text);
  await append(`## User — ${localTime(m.timestamp)}\n\n${text}\n\n`);
}

// deno-lint-ignore no-explicit-any
async function logAssistant(m: any): Promise<void> {
  const parts: string[] = [`## Assistant — ${localTime(m.timestamp)}\n\n`];
  // deno-lint-ignore no-explicit-any
  const content: any[] = Array.isArray(m.content) ? m.content : [];
  for (const block of content) {
    if (!block) continue;
    if (block.type === "text" && block.text) {
      parts.push(block.text.trimEnd() + "\n\n");
    } else if (block.type === "thinking" && block.text) {
      const trimmed = block.text.trim();
      if (trimmed) parts.push(`<details><summary>Thinking</summary>\n\n${trimmed}\n\n</details>\n\n`);
    } else if (block.type === "toolCall") {
      const args = JSON.stringify(block.arguments ?? {}, null, 2);
      parts.push(`### Tool call: \`${block.name}\` (id: ${block.id})\n\n\`\`\`json\n${args}\n\`\`\`\n\n`);
    }
  }
  if (m.errorMessage) {
    parts.push(`> **Error:** ${m.errorMessage}\n\n`);
  }
  await append(parts.join(""));
}

// deno-lint-ignore no-explicit-any
async function logToolResult(m: any): Promise<void> {
  const text = extractText(m.content);
  const truncated = text.length > 4000 ? text.slice(0, 4000) + "\n…(truncated)" : text;
  const header = `### Tool result: \`${m.toolName}\` (id: ${m.toolCallId})${m.isError ? " — ERROR" : ""}\n\n`;
  await append(header + "```\n" + truncated + "\n```\n\n");
}

/** Hook into a pi-agent-core Agent's subscribe callback to log message_end events. */
// deno-lint-ignore no-explicit-any
export async function logMessageEnd(message: any): Promise<void> {
  if (!message?.role) return;
  if (message.role === "user") return await logUser(message);
  if (message.role === "user-with-attachments") return await logUser({ ...message, content: message.content });
  if (message.role === "assistant") return await logAssistant(message);
  if (message.role === "toolResult") return await logToolResult(message);
}

/** Current file path (mostly for tests / introspection). */
export function getCurrentConversationPath(): string | null {
  return currentPath;
}
