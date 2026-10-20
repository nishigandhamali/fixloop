"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Mic, Send, Square, Volume2, VolumeX } from "lucide-react";
import { btnGhost, btnPrimary, Card } from "@/components/shared/ui";
import { gw, GatewayError } from "@/lib/client";
import type { Card as TCard } from "@/lib/types";
import { createSpeechInput, createSpeechOutput, type SpeechInput, type SpeechOutput } from "./speech";
import { TurnCards } from "./TurnCards";

export type VoiceState = "IDLE" | "LISTENING" | "TRANSCRIBING" | "PROCESSING" | "AWAITING_CONFIRMATION" | "SPEAKING" | "ERROR";
interface Msg { role: "user" | "assistant"; text: string; cards?: TCard[]; trace?: { name: string; ok: boolean; ms: number }[]; degraded?: boolean }
const STATE_TEXT: Record<VoiceState, string> = { IDLE: "Ready", LISTENING: "Listening…", TRANSCRIBING: "Transcribing…", PROCESSING: "Working on it…", AWAITING_CONFIRMATION: "Waiting for your approval", SPEAKING: "Speaking…", ERROR: "Something went wrong" };

export function VoiceConsole({ suggested }: { suggested?: string }) {
  const [state, setState] = useState<VoiceState>("IDLE");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState(suggested ?? "");
  const [error, setError] = useState<string | null>(null);
  const [speakReplies, setSpeakReplies] = useState(true);
  const [autoSend, setAutoSend] = useState(false);
  const [canListen, setCanListen] = useState(false);
  const sessionId = useRef<string | null>(null);
  const input = useRef<SpeechInput | null>(null);
  const output = useRef<SpeechOutput | null>(null);
  const lastRef = useRef<HTMLDivElement>(null);
  const awaiting = useRef(false);
  const router = useRouter();

  useEffect(() => {
    input.current = createSpeechInput(); output.current = createSpeechOutput(); setCanListen(input.current.supported);
    return () => { output.current?.cancel(); input.current?.stop(); }; // no recording or speech continues after navigation
  }, []);
  useEffect(() => { lastRef.current?.scrollIntoView({ block: "start" }); }, [msgs]); // newest message from its start, so long replies are read top-down

  const settle = useCallback(() => setState(awaiting.current ? "AWAITING_CONFIRMATION" : "IDLE"), []);

  const send = useCallback(async (raw: string) => {
    const t = raw.trim(); if (!t || state === "PROCESSING") return;
    output.current?.cancel(); setError(null); setText(""); setMsgs((m) => [...m, { role: "user", text: t }]); setState("PROCESSING");
    try {
      if (!sessionId.current) sessionId.current = (await gw<{ session: { id: string } }>("conversations", { method: "POST" })).session.id;
      const r = await gw<{ spoken: string; cards: TCard[]; uiState: string; trace: Msg["trace"]; degraded: boolean }>(`conversations/${sessionId.current}/messages`, { json: { text: t } });
      awaiting.current = r.uiState === "AWAITING_CONFIRMATION";
      setMsgs((m) => [...m, { role: "assistant", text: r.spoken, cards: r.cards, trace: r.trace, degraded: r.degraded }]);
      if (r.uiState === "ERROR") setState("ERROR");
      else if (speakReplies && output.current?.supported) { setState("SPEAKING"); output.current.speak(r.spoken, { onEnd: settle }); }
      else settle();
      router.refresh();
    } catch (e) {
      const msg = e instanceof GatewayError ? (e.status === 401 ? "Your demo session expired. Reload the page." : e.message) : "Network problem. Check the connection and try again.";
      setError(msg); setState("ERROR");
    }
  }, [state, speakReplies, settle, router]);

  function toggleMic() {
    if (!input.current?.supported) return;
    if (state === "LISTENING") { setState("TRANSCRIBING"); input.current.stop(); return; }
    output.current?.cancel(); setError(null); setState("LISTENING");
    let finalText = "";
    input.current.start({
      onInterim: (t) => setText(t),
      onFinal: (t) => { finalText = t; setText(t); },
      onEnd: () => { if (autoSend && finalText) void send(finalText); else settle(); },
      onError: (code) => { setError(code === "not-allowed" || code === "service-not-allowed" ? "Microphone permission was denied. You can type instead." : `Speech recognition error (${code}). You can type instead.`); setState("ERROR"); },
    });
  }
  function stopSpeaking() { output.current?.cancel(); settle(); }

  return (
    <Card label="Conversation" className="flex flex-col">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-display text-xl">Talk to FixLoop</h2>
        <span role="status" aria-live="polite" data-testid="voice-state" data-state={state} className="rounded-full bg-infobg px-3 py-1 text-xs font-semibold">{STATE_TEXT[state]}</span>
      </div>
      <p className="mt-1 text-xs text-muted">Try saying “Alexa, my dishwasher is leaking” (a demo phrase: no wake word, no Echo device). Audio is processed by your browser’s speech service only while you hold the mic on; nothing is recorded by FixLoop. Typing always works.</p>

      <div className="mt-4 max-h-[28rem] min-h-40 space-y-4 overflow-y-auto pr-1" aria-live="polite" aria-label="Conversation transcript" data-testid="transcript">
        {msgs.length === 0 && <p className="text-sm text-muted">No messages yet.</p>}
        {msgs.map((m, i) => (
          <div key={i} ref={i === msgs.length - 1 ? lastRef : undefined} className={m.role === "user" ? "ml-8 rounded-2xl bg-accent/10 p-3" : "mr-4"} data-role={m.role}>
            <div className="text-xs font-semibold text-muted">{m.role === "user" ? "You" : "FixLoop"}</div>
            <p className="text-sm leading-relaxed">{m.text}</p>
            {m.degraded && <p className="text-xs text-warn">Language model unavailable: using the built-in deterministic fallback.</p>}
            {m.cards && <TurnCards cards={m.cards} onChoose={(t) => void send(`status of ${t}`)} onDecided={(s) => { awaiting.current = false; if (state !== "SPEAKING") setState("IDLE"); void s; }} />}
            {m.trace && m.trace.length > 0 && <details className="mt-1 text-xs text-muted"><summary>{m.trace.length} MCP tool call{m.trace.length > 1 ? "s" : ""}</summary><ul>{m.trace.map((t, j) => <li key={j}>{t.name} · {t.ok ? "ok" : "error"} · {t.ms} ms</li>)}</ul></details>}
          </div>
        ))}
      </div>

      {error && <p role="alert" className="mt-3 rounded-lg bg-dangerbg p-2 text-sm text-danger">{error}</p>}

      <form className="mt-4 flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
        <label className="sr-only" htmlFor="utterance">Your message</label>
        <textarea id="utterance" data-testid="utterance" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Type or dictate what's wrong…" className="w-full resize-none rounded-xl border border-line bg-surface p-3 text-sm" onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(text); } }} />
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={toggleMic} disabled={!canListen || state === "PROCESSING"} aria-pressed={state === "LISTENING"} className={`${btnPrimary} ${state === "LISTENING" ? "listening" : ""}`} title={canListen ? "Push to talk" : "Speech recognition isn't available in this browser"}>
            <Mic size={18} aria-hidden /> {state === "LISTENING" ? "Stop listening" : "Push to talk"}
          </button>
          <button type="submit" className={btnGhost} disabled={!text.trim() || state === "PROCESSING"} data-testid="send"><Send size={16} aria-hidden /> Send</button>
          {state === "SPEAKING" && <button type="button" className={btnGhost} onClick={stopSpeaking}><Square size={16} aria-hidden /> Stop speaking</button>}
          <button type="button" className={btnGhost} aria-pressed={speakReplies} onClick={() => { if (speakReplies) output.current?.cancel(); setSpeakReplies(!speakReplies); }}>{speakReplies ? <Volume2 size={16} aria-hidden /> : <VolumeX size={16} aria-hidden />} Spoken replies {speakReplies ? "on" : "off"}</button>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-xs text-muted">
          <label className="flex items-center gap-2"><input type="checkbox" checked={autoSend} onChange={(e) => setAutoSend(e.target.checked)} /> Send automatically when I stop talking</label>
          {!canListen && <span data-testid="no-mic">Voice input unavailable in this browser; text works fully.</span>}
        </div>
      </form>
    </Card>
  );
}
