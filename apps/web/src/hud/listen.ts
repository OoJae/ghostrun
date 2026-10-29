// The browser's own speech recognition (Chrome and Safari ship one; Firefox and the Quest browser
// don't, and the mics hide there); no audio passes through us. Shared by the prompt bar's mic and
// the talk box's hold-to-talk.

export interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void;
  stop(): void;
}
export type RecognitionCtor = new () => Recognition;

export const speechApi = (): RecognitionCtor | undefined => {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
};

const VOICE_NOTE = "gr_voice_note";

/** The first time anyone speaks: whose speech service hears it (null once said). */
export function firstVoiceNote(): string | null {
  try {
    if (localStorage.getItem(VOICE_NOTE)) return null;
    localStorage.setItem(VOICE_NOTE, "1");
  } catch {
    // storage blocked: the note shows each time, which is fine
  }
  return "Voice uses your browser's speech service (Google in Chrome, Apple in Safari); GHOSTRUN only receives the text.";
}

/** What went wrong, in words (a blocked mic says how to allow it). */
export const voiceError = (error: string, what: string) => (error === "not-allowed" ? `Microphone blocked: allow it in the address bar to ${what}.` : `Voice stopped (${error}).`);

/** All the results so far as one line. */
export const transcript = (e: Parameters<NonNullable<Recognition["onresult"]>>[0]) => Array.from(e.results, (x) => x[0]?.transcript ?? "").join(" ").trim();
