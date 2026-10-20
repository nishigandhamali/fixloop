import type { ReactNode } from "react";

export function Card({ children, className = "", tone = "plain", label }: { children: ReactNode; className?: string; tone?: "plain" | "warn" | "danger" | "ok" | "info"; label?: string }) {
  const tones = { plain: "bg-surface border-line", warn: "bg-warnbg border-warn/40", danger: "bg-dangerbg border-danger/50", ok: "bg-okbg border-ok/40", info: "bg-infobg border-line" } as const;
  return <section aria-label={label} className={`rounded-2xl border p-5 shadow-[0_1px_0_rgba(0,0,0,0.03)] ${tones[tone]} ${className}`}>{children}</section>;
}

const PILL: Record<string, string> = {
  VERIFIED: "bg-okbg text-ok", PARTIALLY_SUPPORTED: "bg-warnbg text-warn", UNVERIFIED: "bg-warnbg text-warn", CONFLICTING: "bg-dangerbg text-danger", NOT_FOUND: "bg-infobg text-muted",
  EMERGENCY: "bg-dangerbg text-danger", HIGH: "bg-dangerbg text-danger", MODERATE: "bg-warnbg text-warn", LOW: "bg-okbg text-ok", UNKNOWN: "bg-infobg text-muted",
  RESOLVED: "bg-okbg text-ok", SAFETY_ESCALATED: "bg-dangerbg text-danger", ACTION_PENDING: "bg-warnbg text-warn", IN_PROGRESS: "bg-infobg text-ink",
  SENT: "bg-okbg text-ok", DRAFT: "bg-infobg text-muted", PENDING_APPROVAL: "bg-warnbg text-warn", APPROVED: "bg-infobg text-ink", FAILED: "bg-dangerbg text-danger", CANCELED: "bg-infobg text-muted",
  SUCCEEDED: "bg-okbg text-ok", UNKNOWN_OUTCOME: "bg-warnbg text-warn", FAILED_RETRYABLE: "bg-warnbg text-warn", FAILED_PERMANENT: "bg-dangerbg text-danger", PENDING: "bg-warnbg text-warn",
};
export const label = (s: string) => s.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
export function Pill({ value, text }: { value: string; text?: string }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${PILL[value] ?? "bg-infobg text-ink"}`}>{text ?? label(value)}</span>;
}

export const btn = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed";
export const btnPrimary = `${btn} bg-accent text-accent-ink hover:brightness-110`;
export const btnGhost = `${btn} border border-line bg-surface text-ink hover:bg-infobg`;
export const btnDanger = `${btn} bg-danger text-accent-ink hover:brightness-110`;

export function Disclosure() {
  return <p className="text-xs text-muted">FixLoop is an informational assistant, not an emergency or professional repair service. Requests go to a <strong>simulated</strong> provider; no real technician is contacted.</p>;
}
export const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
