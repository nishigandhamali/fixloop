/**
 * Pure, deterministic evidence logic. No I/O. Treats all document text as untrusted DATA.
 */
import { createHash } from "node:crypto";

export type VerificationStatus = "VERIFIED" | "PARTIALLY_SUPPORTED" | "UNVERIFIED" | "CONFLICTING" | "NOT_FOUND";

// ---------- chunking ----------
export const MAX_CHUNK_CHARS = 600;

export interface Sentence { text: string; start: number; end: number }

/** Sentence split that preserves exact offsets into the source string. */
export function splitSentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  const re = /[^.!?\n]+(?:[.!?]+|\n|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    const raw = m[0];
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed) out.push({ text: trimmed, start: m.index + lead, end: m.index + lead + trimmed.length });
  }
  return out;
}

/** Deterministic: pack whole sentences into chunks of <= MAX_CHUNK_CHARS (a lone long sentence is hard-split). */
export function chunkPage(pageText: string): string[] {
  const normalized = pageText.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  let cur = "";
  const push = () => { if (cur.trim()) chunks.push(cur.trim()); cur = ""; };
  for (const s of splitSentences(normalized)) {
    let t = s.text;
    while (t.length > MAX_CHUNK_CHARS) { push(); chunks.push(t.slice(0, MAX_CHUNK_CHARS)); t = t.slice(MAX_CHUNK_CHARS); }
    if (cur && cur.length + 1 + t.length > MAX_CHUNK_CHARS) push();
    cur = cur ? `${cur} ${t}` : t;
  }
  push();
  return chunks;
}

export const contentHash = (s: string) => createHash("sha256").update(s).digest("hex");

// ---------- terms ----------
const STOPWORDS = new Set("the a an is are was were my our your do does did how what when where why which can i it to of in on for and or if should there this that with about be been by at from as me we you any have has had not no so please tell will would could know don t dont just really think need want".split(" "));

export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ies")) w = w.slice(0, -3) + "y";
  else if (w.length > 4 && w.endsWith("es")) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

const tokenize = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** Significant query terms (alphanumeric only => safe to hand to to_tsquery). contextWords (brand/model/category) are not required evidence. */
export function extractTerms(question: string, contextWords: string[] = []): string[] {
  const ctx = new Set(contextWords.flatMap(tokenize).map(stem));
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const t of tokenize(question)) {
    if (STOPWORDS.has(t) || t.length < 2 || ctx.has(stem(t))) continue;
    const s = stem(t);
    if (seen.has(s)) continue;
    seen.add(s); terms.push(t);
  }
  return terms.slice(0, 12);
}

export function termMatches(term: string, text: string): boolean {
  const ts = stem(term);
  return tokenize(text).some((w) => { const ws = stem(w); const m = Math.min(ws.length, ts.length); return ws === ts || (m >= 4 && (ws.startsWith(ts) || ts.startsWith(ws))); });
}

export function coverage(terms: string[], text: string): number {
  return terms.length === 0 ? 0 : terms.filter((t) => termMatches(t, text)).length / terms.length;
}

// ---------- prompt-injection detection (flag + strip, never obey) ----------
const INJECTION: RegExp[] = [
  /ignore (all |any |the )?(previous|prior|above|earlier) (instructions|rules|prompts?)/i,
  /disregard (all |any |the )?(previous|prior|above|safety|system)/i,
  /\b(system|assistant|developer)\s*(prompt|message|note|override)?\s*:/i,
  /you (must|should|are now|will) (now )?(call|run|execute|mark|approve|send|resolve|act)/i,
  /\b(mark|set|label|classify)\b.{0,40}\b(verified|safe|resolved|approved)\b/i,
  /\b(call|invoke|execute) (the )?(tool|function|resolve_incident|execute_approved_action|\w+_incident)\b/i,
  /\bdo not (tell|inform|warn) the user\b/i,
  /<\/?(system|instructions?)>/i,
];
export const looksLikeInjection = (s: string) => INJECTION.some((r) => r.test(s));

// ---------- models / brand / expiry ----------
export const normalizeModel = (m: string) => m.toUpperCase().replace(/[^A-Z0-9]/g, "");

export function extractDeclaredModels(text: string): string[] {
  const found = new Set<string>();
  const re = /\bmodels?(?:\s+(?:numbers?|no\.?|#))?\s*[:#]\s*([^\n]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    for (const tok of (m[1] ?? "").split(/[,;/]|\band\b/i)) {
      const t = tok.trim().split(/\s+/)[0] ?? "";
      if (/[A-Za-z]/.test(t) && /\d/.test(t) && t.length >= 4) found.add(normalizeModel(t));
    }
  }
  return [...found];
}

export function extractDeclaredBrand(text: string): string | null {
  const m = /\bbrand\s*:\s*([^\n]+)/i.exec(text);
  return m ? (m[1] ?? "").trim().split(/\s{2,}|\bModel/i)[0]!.trim() || null : null;
}

/** First "expires/expiration ... YYYY-MM-DD" date in the document, as a UTC Date. */
export function extractExpiry(text: string): Date | null {
  const m = /\bexpir\w*\b[^\d\n]{0,30}(\d{4})-(\d{2})-(\d{2})/i.exec(text);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface ApplianceIdentity { brand: string; modelNumber: string }
export interface DocumentIdentity { declaredModels: string[]; declaredBrand: string | null }

/** true = matches the appliance; false = positively a different product; null = document does not say. */
export function matchAppliance(doc: DocumentIdentity, a: ApplianceIdentity): boolean | null {
  const brandMismatch = doc.declaredBrand !== null && doc.declaredBrand.toLowerCase() !== a.brand.toLowerCase();
  if (brandMismatch) return false;
  if (doc.declaredModels.length === 0) return null;
  return doc.declaredModels.includes(normalizeModel(a.modelNumber));
}

// ---------- snippet selection (always an exact substring of the chunk) ----------
export interface SnippetResult { snippet: string; coverage: number; injectionDetected: boolean }

/** Best window of up to 2 adjacent CLEAN sentences. Injection sentences are never quoted. */
export function bestSnippet(content: string, terms: string[]): SnippetResult {
  const sentences = splitSentences(content);
  const injectionDetected = sentences.some((s) => looksLikeInjection(s.text));
  let best: SnippetResult = { snippet: "", coverage: 0, injectionDetected };
  for (let i = 0; i < sentences.length; i++) {
    for (const len of [1, 2]) {
      const win = sentences.slice(i, i + len);
      if (win.length < len || win.some((s) => looksLikeInjection(s.text))) continue;
      const snippet = content.slice(win[0]!.start, win[win.length - 1]!.end);
      const cov = coverage(terms, snippet);
      if (cov > best.coverage || (cov === best.coverage && best.snippet && snippet.length < best.snippet.length)) best = { snippet, coverage: cov, injectionDetected };
    }
  }
  return best;
}

// ---------- quantities & conflicts ----------
const UNIT = "months?|years?|days?|weeks?|hours?|minutes?|psi|bar|cycles?";
export function extractQuantities(text: string): { value: number; unit: string }[] {
  const out: { value: number; unit: string }[] = [];
  const re = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNIT})\\b`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push({ value: Number(m[1]), unit: (m[2] ?? "").toLowerCase().replace(/s$/, "") });
  return out;
}

/** Two snippets conflict if they state different values in the same unit. */
export function snippetsConflict(a: string, b: string): boolean {
  const qa = extractQuantities(a), qb = extractQuantities(b);
  return qa.some((x) => qb.some((y) => x.unit === y.unit && x.value !== y.value)) &&
    !qa.some((x) => qb.some((y) => x.unit === y.unit && x.value === y.value));
}

// ---------- classification ----------
export interface HitInput {
  snippet: string; coverage: number; modelMatch: boolean | null; injectionDetected: boolean;
}

export function classifyHit(h: HitInput): { status: VerificationStatus; uncertainties: string[] } {
  const u: string[] = [];
  if (h.injectionDetected) u.push("Source text contained instruction-like content; it was ignored and not quoted.");
  if (h.modelMatch === false) { u.push("Document is for a different product than the registered appliance."); return { status: "UNVERIFIED", uncertainties: u }; }
  if (h.snippet === "") return { status: "UNVERIFIED", uncertainties: [...u, "No clean supporting text."] };
  if (h.modelMatch === null) {
    u.push("Document does not state a model number, so it cannot be tied to this appliance.");
    return { status: h.coverage >= 0.5 ? "PARTIALLY_SUPPORTED" : "UNVERIFIED", uncertainties: u };
  }
  if (h.coverage >= 1) return { status: "VERIFIED", uncertainties: u };
  if (h.coverage >= 0.5) { u.push("Source addresses only part of the question."); return { status: "PARTIALLY_SUPPORTED", uncertainties: u }; }
  return { status: "UNVERIFIED", uncertainties: [...u, "Weak match to the question."] };
}

const PRECEDENCE: VerificationStatus[] = ["CONFLICTING", "VERIFIED", "PARTIALLY_SUPPORTED", "UNVERIFIED"];
export function overallStatus(statuses: VerificationStatus[]): VerificationStatus {
  if (statuses.length === 0) return "NOT_FOUND";
  return PRECEDENCE.find((p) => statuses.includes(p)) ?? "UNVERIFIED";
}

/** Marks hits CONFLICTING when two model-matched, clean hits state different quantities in the same unit. */
export function applyConflicts<T extends { status: VerificationStatus; snippet: string; modelMatch: boolean | null; uncertainties: string[] }>(hits: T[]): T[] {
  const eligible = hits.map((h, i) => ({ h, i })).filter(({ h }) => h.modelMatch === true && h.snippet && h.status !== "UNVERIFIED");
  const conflicted = new Set<number>();
  for (const a of eligible) for (const b of eligible) if (a.i < b.i && snippetsConflict(a.h.snippet, b.h.snippet)) { conflicted.add(a.i); conflicted.add(b.i); }
  return hits.map((h, i) => conflicted.has(i) ? { ...h, status: "CONFLICTING" as const, uncertainties: [...h.uncertainties, "Another source for this appliance states a different value."] } : h);
}
