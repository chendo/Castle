// Hold-to-talk voice button. UI stub: future versions wire this to Web Speech
// API on push-down + push-up to capture a transcript and send it as a prompt.
// For now the button is visible but inert — it logs a console line so we can
// confirm the gesture path is wired through to the right place.

export function buildVoiceButton(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.setAttribute("aria-label", "Hold to talk (coming soon)");
  btn.title = "Voice input — coming soon";
  btn.innerHTML = `
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="9" y="2" width="6" height="12" rx="3"/>
      <path d="M5 10v2a7 7 0 0 0 14 0v-2"/>
      <line x1="12" y1="19" x2="12" y2="23"/>
      <line x1="8" y1="23" x2="16" y2="23"/>
    </svg>
  `;
  btn.style.cssText = `
    display: inline-flex; align-items: center; justify-content: center;
    width: 40px; height: 40px; border-radius: 999px;
    background: var(--card); color: var(--muted-foreground);
    border: 1px solid var(--border); cursor: pointer;
    flex-shrink: 0; touch-action: none; user-select: none;
  `;
  let pressing = false;
  const press = () => {
    pressing = true;
    btn.style.background = "var(--primary, #58a6ff)";
    btn.style.color = "white";
    console.log("[voice] press (stub)");
  };
  const release = () => {
    if (!pressing) return;
    pressing = false;
    btn.style.background = "var(--card)";
    btn.style.color = "var(--muted-foreground)";
    console.log("[voice] release (stub)");
  };
  btn.addEventListener("pointerdown", (e) => { e.preventDefault(); press(); });
  btn.addEventListener("pointerup", release);
  btn.addEventListener("pointercancel", release);
  btn.addEventListener("pointerleave", release);
  return btn;
}
