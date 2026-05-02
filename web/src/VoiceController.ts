import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { ChatPanel } from "@mariozechner/pi-web-ui";
import type { WebSocketRemoteAgent } from "./WebSocketRemoteAgent";

const PTT_KEY = "hai-voice-ptt";
const TTS_KEY = "hai-voice-tts";

// Browsers ship SpeechRecognition under different names.
const SR: any =
  (typeof window !== "undefined" && (window as any).SpeechRecognition) ||
  (typeof window !== "undefined" && (window as any).webkitSpeechRecognition);

export interface VoiceController {
  isPttSupported: boolean;
  isTtsSupported: boolean;
  pttEnabled: boolean;
  ttsEnabled: boolean;
  setPttEnabled: (v: boolean) => void;
  setTtsEnabled: (v: boolean) => void;
  togglePttRecording: () => void;
  /** True while actively listening for speech input. */
  isRecording: () => boolean;
  /** Subscribe to recording-state changes (for UI badges). */
  onRecordingChange: (cb: (recording: boolean) => void) => void;
}

export function createVoiceController(agent: WebSocketRemoteAgent, chatPanel: ChatPanel): VoiceController {
  const isPttSupported = !!SR;
  const isTtsSupported = typeof window !== "undefined" && "speechSynthesis" in window;

  let pttEnabled = localStorage.getItem(PTT_KEY) === "1";
  let ttsEnabled = localStorage.getItem(TTS_KEY) === "1";

  let recognition: any | null = null;
  let recording = false;
  const recordingListeners = new Set<(r: boolean) => void>();
  const setRecording = (v: boolean) => {
    if (recording === v) return;
    recording = v;
    recordingListeners.forEach((l) => l(v));
  };

  // --- PTT ------------------------------------------------------------------

  function buildRecognition(): any {
    const r = new SR();
    r.continuous = false;
    r.interimResults = true;
    r.maxAlternatives = 1;
    try { r.lang = navigator.language || "en-US"; } catch { /* */ }

    let lastFinal = "";
    let lastInterim = "";

    r.onresult = (ev: any) => {
      lastInterim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const t = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) lastFinal += t;
        else lastInterim += t;
      }
      const combined = (lastFinal + lastInterim).trim();
      // Stream into the chat input as the user speaks.
      try {
        (chatPanel.agentInterface as any)?.setInput?.(combined);
      } catch { /* */ }
    };
    r.onend = () => {
      setRecording(false);
      const text = lastFinal.trim();
      if (text) {
        try { (chatPanel.agentInterface as any)?.setInput?.(text); } catch { /* */ }
      }
    };
    r.onerror = (ev: any) => {
      console.warn("[voice] recognition error:", ev.error);
      setRecording(false);
    };
    return r;
  }

  function togglePttRecording(): void {
    if (!isPttSupported || !pttEnabled) return;
    if (recording) {
      try { recognition?.stop(); } catch { /* */ }
      return;
    }
    try {
      recognition = buildRecognition();
      recognition.start();
      setRecording(true);
    } catch (err) {
      console.warn("[voice] couldn't start recognition:", err);
      setRecording(false);
    }
  }

  // --- TTS ------------------------------------------------------------------

  // Speak an assistant message_end if TTS is on. Cancel any in-flight when
  // a new turn starts so we never overlap.
  if (isTtsSupported) {
    agent.subscribe((event: AgentEvent) => {
      if (!ttsEnabled) return;
      if (event.type === "agent_start" || event.type === "turn_start") {
        try { window.speechSynthesis.cancel(); } catch { /* */ }
        return;
      }
      if (event.type === "message_end" && (event.message as any)?.role === "assistant") {
        const content = (event.message as any).content ?? [];
        const text = content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text ?? "")
          .join(" ")
          .trim();
        if (!text) return;
        // Strip markdown lightly so TTS doesn't read out asterisks/backticks.
        const stripped = text
          .replace(/```[\s\S]*?```/g, "")
          .replace(/`([^`]+)`/g, "$1")
          .replace(/\*\*([^*]+)\*\*/g, "$1")
          .replace(/\*([^*]+)\*/g, "$1")
          .replace(/_([^_]+)_/g, "$1")
          .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
        const utter = new SpeechSynthesisUtterance(stripped);
        try {
          utter.lang = navigator.language || "en-US";
        } catch { /* */ }
        window.speechSynthesis.speak(utter);
      }
    });
  }

  // --- Persistence + getters/setters ----------------------------------------

  return {
    isPttSupported,
    isTtsSupported,
    get pttEnabled() { return pttEnabled; },
    get ttsEnabled() { return ttsEnabled; },
    setPttEnabled(v: boolean) {
      pttEnabled = v;
      localStorage.setItem(PTT_KEY, v ? "1" : "0");
      if (!v && recording) {
        try { recognition?.stop(); } catch { /* */ }
      }
    },
    setTtsEnabled(v: boolean) {
      ttsEnabled = v;
      localStorage.setItem(TTS_KEY, v ? "1" : "0");
      if (!v && isTtsSupported) {
        try { window.speechSynthesis.cancel(); } catch { /* */ }
      }
    },
    togglePttRecording,
    isRecording: () => recording,
    onRecordingChange: (cb) => { recordingListeners.add(cb); },
  };
}
