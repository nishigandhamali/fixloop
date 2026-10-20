"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, btnGhost, btnPrimary } from "@/components/shared/ui";
import { gw, GatewayError } from "@/lib/client";

export function IncidentActions({ incidentId, status }: { incidentId: string; status: string }) {
  const [note, setNote] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const router = useRouter();
  async function run(kind: "resolve" | "reopen") {
    if (busy) return; setBusy(true); setErr(null);
    try {
      await gw(`incidents/${incidentId}/${kind}`, { json: kind === "resolve" ? { resolutionSummary: note || "Resolved by owner", idempotencyKey: `ui-resolve-${incidentId}` } : { reason: note || "Reopened by owner" } });
      setNote(""); router.refresh();
    } catch (e) { setErr(e instanceof GatewayError ? (e.code === "ILLEGAL_TRANSITION" ? "This case can't be resolved from its current stage yet." : e.message) : "Something went wrong"); }
    finally { setBusy(false); }
  }
  const resolved = status === "RESOLVED";
  return (
    <Card label="Resolution">
      <h2 className="font-semibold">{resolved ? "Reopen this case" : "Resolve this case"}</h2>
      <label className="mt-2 block text-sm" htmlFor="note">{resolved ? "Why is it back?" : "What fixed it? (optional)"}</label>
      <input id="note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className="mt-1 w-full rounded-xl border border-line bg-surface p-2 text-sm" />
      <div className="mt-3"><button className={resolved ? btnGhost : btnPrimary} disabled={busy} onClick={() => run(resolved ? "reopen" : "resolve")}>{resolved ? "Reopen" : "Mark resolved"}</button></div>
      {err && <p role="alert" className="mt-2 text-sm text-danger">{err}</p>}
    </Card>
  );
}
