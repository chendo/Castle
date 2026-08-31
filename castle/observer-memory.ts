// The observer's durable memory: <DATA_DIR>/observer/MEMORY.md.
//
// Why a file and not conversation history. The observer runs a long-lived
// session with a rolling context that compacts once it passes its window —
// older turns get summarised away. Anything the observer needs to still know
// next week therefore cannot live in the transcript. Memory is re-injected
// into every pass prompt from this file, which makes it the one layer that
// compaction cannot erode: the window is lossy for events and lossless for
// memory, because memory is a file rather than a message.
//
// Ownership is deliberately split three ways across the feature:
//
//   preferences  user only, never the LLM     settings.observer (mutes, cadences)
//   feedback     user actions                 observation dismissals
//   memory       LLM writes, user edits       this file
//
// So this is the only one of the three the model can write, and it is capped
// and plain-text on purpose — the user has to be able to open it, read what
// their house agent believes about them, and delete a line by hand.
//
// Format is markdown with a stable `[m_xxx]` id per line so castle_forget can
// name one unambiguously. Hand-edited lines without an id get one assigned on
// the next load, so editing the file never has to respect our conventions.

import { DATA_DIR } from "./paths.ts";

export interface MemoryNote {
  id: string;
  section: string;
  text: string;
}

/** Roughly 2k tokens. Big enough for real household context, small enough that
 *  it can be prepended to every pass without dominating the prompt. */
const MAX_NOTES = 40;
const DEFAULT_SECTION = "Notes";
const ID_PATTERN = /^\s*-\s*\[(m_[a-z0-9]+)\]\s*(.*)$/;
const PLAIN_PATTERN = /^\s*-\s+(.*)$/;
const HEADING_PATTERN = /^\s*##\s+(.*?)\s*$/;

function genId(): string {
  return `m_${Math.random().toString(36).slice(2, 8)}`;
}

/** Parse MEMORY.md into notes. Tolerant by design — this file is meant to be
 *  hand-editable, so anything that isn't a heading or a bullet is skipped
 *  rather than treated as corruption. */
export function parseMemory(text: string): MemoryNote[] {
  const notes: MemoryNote[] = [];
  let section = DEFAULT_SECTION;
  for (const line of text.split("\n")) {
    const heading = HEADING_PATTERN.exec(line);
    if (heading) {
      section = heading[1] || DEFAULT_SECTION;
      continue;
    }
    const withId = ID_PATTERN.exec(line);
    if (withId) {
      if (withId[2].trim()) notes.push({ id: withId[1], section, text: withId[2].trim() });
      continue;
    }
    const plain = PLAIN_PATTERN.exec(line);
    if (plain && plain[1].trim()) {
      notes.push({ id: genId(), section, text: plain[1].trim() });
    }
  }
  return notes;
}

/** Render notes back to markdown, grouped by section in first-seen order. */
export function renderMemory(notes: MemoryNote[]): string {
  if (notes.length === 0) return "";
  const bySection = new Map<string, MemoryNote[]>();
  for (const n of notes) {
    const bucket = bySection.get(n.section);
    if (bucket) bucket.push(n);
    else bySection.set(n.section, [n]);
  }
  const out: string[] = [];
  for (const [section, items] of bySection) {
    out.push(`## ${section}`);
    for (const n of items) out.push(`- [${n.id}] ${n.text}`);
    out.push("");
  }
  return out.join("\n").trimEnd() + "\n";
}

export class MemoryStore {
  private notes: MemoryNote[] = [];
  private loaded = false;

  constructor(private readonly root: string = `${DATA_DIR}/observer`) {}

  private get file(): string {
    return `${this.root}/MEMORY.md`;
  }

  /**
   * Load from disk. Rewrites the file when hand-edited lines needed ids
   * assigned, so the ids the model is told about match what is on disk.
   */
  async init(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let text: string;
    try {
      text = await Deno.readTextFile(this.file);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) {
        console.warn("[observer] could not read memory:", (err as Error).message);
      }
      return;
    }
    const before = text;
    this.notes = parseMemory(text);
    if (renderMemory(this.notes) !== before) await this.persist();
  }

  list(): MemoryNote[] {
    return [...this.notes];
  }

  /**
   * Add a note. Returns its id. Oldest notes are dropped past the cap — the
   * observer is told to consolidate rather than append, but the cap is what
   * guarantees the prompt cost stays bounded if it doesn't.
   */
  async remember(text: string, section = DEFAULT_SECTION): Promise<MemoryNote> {
    const note: MemoryNote = { id: genId(), section: section.trim() || DEFAULT_SECTION, text: text.trim() };
    this.notes.push(note);
    if (this.notes.length > MAX_NOTES) this.notes = this.notes.slice(-MAX_NOTES);
    await this.persist();
    return note;
  }

  /** Drop a note by id. Returns whether anything matched. */
  async forget(id: string): Promise<boolean> {
    const before = this.notes.length;
    this.notes = this.notes.filter((n) => n.id !== id);
    if (this.notes.length === before) return false;
    await this.persist();
    return true;
  }

  async clear(): Promise<void> {
    this.notes = [];
    await this.persist();
  }

  /** The block injected into every pass prompt, or null when empty so the
   *  caller can omit the heading entirely rather than print an empty section. */
  render(): string | null {
    return this.notes.length === 0 ? null : renderMemory(this.notes).trimEnd();
  }

  private async persist(): Promise<void> {
    try {
      await Deno.mkdir(this.root, { recursive: true });
      await Deno.writeTextFile(this.file, renderMemory(this.notes));
    } catch (err) {
      console.warn("[observer] could not persist memory:", (err as Error).message);
    }
  }
}
