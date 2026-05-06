// Suggested starter prompts shown above the chat input when the
// conversation is empty. Time-of-day-aware so the suggestions feel
// relevant: "what's on" before bed reads differently from
// "what's the weather" in the morning. Click → drops the prompt
// straight into the chat as a user message.
//
// Visibility is bound to the agent's message count: as soon as the
// user sends a prompt (or resumes a session), the panel hides itself.
//
// Prompts are intentionally generic ("show me the kitchen", not
// "turn on light.kitchen_island") so they exercise the agent's
// resolution path rather than hardcoding entity_ids the user might
// not have.

import type { WebSocketRemoteAgent } from "./WebSocketRemoteAgent";

interface PromptBucket {
  greeting: string;
  prompts: string[];
}

const TIME_BUCKETS: PromptBucket[] = [
  // 0-4 → late night
  {
    greeting: "Late night",
    prompts: [
      "What's still on?",
      "Turn off all lights",
      "Show me the front door camera",
      "Is anyone home?",
    ],
  },
  // 5-10 → morning
  {
    greeting: "Good morning",
    prompts: [
      "What's the weather today?",
      "Show me the kitchen",
      "What's playing in the bedroom?",
      "Any motion overnight?",
    ],
  },
  // 11-16 → day
  {
    greeting: "Afternoon",
    prompts: [
      "Status of all lights",
      "Show me the lounge temperature over the last 6 hours",
      "Any notifications I should know about?",
      "Turn off everything in the office",
    ],
  },
  // 17-21 → evening
  {
    greeting: "Evening",
    prompts: [
      "Set the lounge for movie night",
      "Show me the bedroom",
      "What's the temperature outside?",
      "Lock the front door",
    ],
  },
  // 22-23 → wind-down
  {
    greeting: "Winding down",
    prompts: [
      "Show me everything that's still on",
      "Turn off the downstairs lights",
      "Set the bedroom for sleep",
      "Any doors unlocked?",
    ],
  },
];

function bucketForHour(h: number): PromptBucket {
  if (h < 5) return TIME_BUCKETS[0];
  if (h < 11) return TIME_BUCKETS[1];
  if (h < 17) return TIME_BUCKETS[2];
  if (h < 22) return TIME_BUCKETS[3];
  return TIME_BUCKETS[4];
}

export function buildStarterPrompts(agent: WebSocketRemoteAgent): HTMLElement {
  const root = document.createElement("div");
  root.style.cssText = `
    position: absolute; left: 0; right: 0; bottom: 80px;
    padding: 0 16px;
    display: none;
    flex-direction: column; gap: 8px;
    pointer-events: none;
  `;

  const bucket = bucketForHour(new Date().getHours());

  const heading = document.createElement("div");
  heading.style.cssText = "font-size: 12px; color: var(--muted-foreground); text-align: center; pointer-events: none;";
  heading.textContent = `${bucket.greeting} — try asking…`;
  root.appendChild(heading);

  const grid = document.createElement("div");
  grid.style.cssText = `
    display: grid; grid-template-columns: 1fr 1fr; gap: 6px;
    pointer-events: auto;
  `;
  for (const p of bucket.prompts.slice(0, 4)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = p;
    btn.style.cssText = `
      padding: 8px 12px; font-size: 12px;
      background: var(--card, var(--background)); color: var(--foreground);
      border: 1px solid var(--border); border-radius: 8px;
      cursor: pointer; text-align: left;
      font-family: inherit; line-height: 1.3;
    `;
    btn.onmouseenter = () => { btn.style.background = "var(--muted)"; };
    btn.onmouseleave = () => { btn.style.background = "var(--card, var(--background))"; };
    btn.onclick = () => {
      // The agent's WS client sends the prompt the same way the input
      // box does — pass straight through, no extra wrapping.
      agent.sendRaw({ type: "prompt", text: p });
    };
    grid.appendChild(btn);
  }
  root.appendChild(grid);

  // Visibility: show when the conversation is empty, hide as soon as
  // there's at least one assistant or user message. agent.subscribe
  // fires on every event so we check on each tick — cheap, since the
  // check is just inspecting an array length.
  const update = () => {
    // deno-lint-ignore no-explicit-any
    const messages = (agent as any).state?.messages as unknown[] | undefined;
    const empty = !messages || messages.length === 0;
    root.style.display = empty ? "flex" : "none";
  };
  agent.subscribe(update);
  update();

  return root;
}
