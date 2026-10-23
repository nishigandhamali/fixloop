"use client";
/** Capability-detected browser speech adapters. Swappable for a streaming provider later; no audio leaves the browser from this code. */
export interface SpeechInput {
  readonly supported: boolean;
  start(h: { onInterim(t: string): void; onFinal(t: string): void; onEnd(): void; onError(code: string): void }): void;
  stop(): void;
}
export interface SpeechOutput {
  readonly supported: boolean;
  speak(text: string, h: { onEnd(): void }): void;
  cancel(): void;
}

type Rec = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
};

export function createSpeechInput(): SpeechInput {
  const Ctor = typeof window !== "undefined" ? ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition) : undefined;
  if (!Ctor) return { supported: false, start: () => undefined, stop: () => undefined };
  let rec: Rec | null = null;
  return {
    supported: true,
    start(h) {
      rec = new Ctor() as Rec;
      rec.lang = navigator.language || "en-US";
      rec.interimResults = true;
      rec.continuous = false;
      rec.onresult = (e) => {
        let interim = "",
          final = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) final += r[0].transcript;
          else interim += r[0].transcript;
        }
        if (interim) h.onInterim(interim);
        if (final) h.onFinal(final);
      };
      rec.onerror = (e) => h.onError(e.error ?? "unknown");
      rec.onend = () => h.onEnd();
      rec.start();
    },
    stop() {
      try {
        rec?.stop();
      } catch {
        /* already stopped */
      }
    },
  };
}

export function createSpeechOutput(): SpeechOutput {
  if (typeof window === "undefined" || !window.speechSynthesis)
    return { supported: false, speak: (_t, h) => h.onEnd(), cancel: () => undefined };
  return {
    supported: true,
    speak(text, h) {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      // Some engines never fire onend (or have no voices). Settle after an estimated duration so the UI can't get stuck "speaking".
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        h.onEnd();
      };
      const timer = setTimeout(finish, Math.max(3000, text.length * 90 + 3000));
      u.onend = finish;
      u.onerror = finish;
      window.speechSynthesis.speak(u);
    },
    cancel() {
      window.speechSynthesis.cancel();
    },
  };
}
