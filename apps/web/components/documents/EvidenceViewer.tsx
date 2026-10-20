"use client";
import { useState } from "react";
import { Card, btnGhost } from "@/components/shared/ui";
import { gw, GatewayError } from "@/lib/client";
import { EvidenceList, type EvidenceItemView } from "./EvidenceList";

interface Result { overallStatus: string; searchedDocuments: number; evidence: { claim: string; verificationStatus: string; uncertainties: string[]; sources: { filename: string; pageNumber: number; modelMatch: boolean | null }[] }[] }

export function EvidenceViewer({ incidentId, defaultQuestion }: { incidentId: string; defaultQuestion: string }) {
  const [q, setQ] = useState(defaultQuestion); const [res, setRes] = useState<Result | null>(null); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  async function ask() {
    setBusy(true); setErr(null);
    try { setRes(await gw<Result>(`incidents/${incidentId}/evidence?question=${encodeURIComponent(q)}`)); }
    catch (e) { setErr(e instanceof GatewayError ? e.message : "Lookup failed"); } finally { setBusy(false); }
  }
  const items: EvidenceItemView[] = (res?.evidence ?? []).map((e) => ({ claim: e.claim, status: e.verificationStatus, filename: e.sources[0]!.filename, page: e.sources[0]!.pageNumber, modelMatch: e.sources[0]!.modelMatch, uncertainties: e.uncertainties }));
  return (
    <Card label="Evidence viewer">
      <h2 className="font-semibold">Evidence from your documents</h2>
      <p className="text-xs text-muted">Read-only lookup. Only text from a document whose model matches your appliance can be marked verified.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <label className="sr-only" htmlFor="evq">Question</label>
        <input id="evq" value={q} onChange={(e) => setQ(e.target.value)} className="min-w-0 flex-1 rounded-xl border border-line bg-surface p-2 text-sm" />
        <button className={btnGhost} disabled={busy || q.trim().length < 3} onClick={ask}>Search</button>
      </div>
      {err && <p role="alert" className="mt-2 text-sm text-danger">{err}</p>}
      {res && <div className="mt-3" data-testid="evidence-result"><EvidenceList overall={res.overallStatus} items={items} /><p className="mt-2 text-xs text-muted">Searched {res.searchedDocuments} document(s).</p></div>}
    </Card>
  );
}
