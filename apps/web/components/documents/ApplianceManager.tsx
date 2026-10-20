"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, Pill, btnGhost, btnPrimary } from "@/components/shared/ui";
import { gw, GatewayError } from "@/lib/client";
import type { Appliance, DocumentMeta } from "@/lib/types";

const field = "mt-1 w-full rounded-xl border border-line bg-surface p-2 text-sm";

export function AddAppliance() {
  const router = useRouter(); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget); setBusy(true); setErr(null);
    try {
      await gw("appliances", { json: Object.fromEntries([...f.entries()].filter(([, v]) => String(v).trim() !== "")) });
      (e.target as HTMLFormElement).reset(); router.refresh();
    } catch (x) { setErr(x instanceof GatewayError ? x.message : "Could not add appliance"); } finally { setBusy(false); }
  }
  return (
    <Card label="Add appliance">
      <h2 className="font-semibold">Add an appliance</h2>
      <form onSubmit={submit} className="mt-2 grid gap-3 sm:grid-cols-2">
        {[["category", "Category (e.g. Dishwasher)"], ["brand", "Brand"], ["modelNumber", "Model number"], ["location", "Location"]].map(([n, l]) => <label key={n} className="text-sm">{l}<input name={n} required={n !== "location"} className={field} /></label>)}
        <div className="sm:col-span-2"><button className={btnPrimary} disabled={busy}>Add appliance</button></div>
      </form>
      {err && <p role="alert" className="mt-2 text-sm text-danger">{err}</p>}
    </Card>
  );
}

export function ApplianceCard({ a, docs }: { a: Appliance; docs: DocumentMeta[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false); const [msg, setMsg] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget); setBusy(true); setErr(null);
    try { await gw(`appliances/${a.id}`, { method: "PATCH", json: { brand: f.get("brand"), modelNumber: f.get("modelNumber"), location: f.get("location") || null } }); setEditing(false); router.refresh(); }
    catch (x) { setErr(x instanceof GatewayError ? x.message : "Could not save"); } finally { setBusy(false); }
  }
  async function upload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget); const file = f.get("file") as File | null; if (!file || file.size === 0) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      const q = new URLSearchParams({ filename: file.name, type: String(f.get("type")), applianceId: a.id });
      const r = await gw<{ duplicate: boolean; chunkCount: number }>(`documents?${q}`, { raw: { body: await file.arrayBuffer(), contentType: file.type || "application/octet-stream" } });
      setMsg(r.duplicate ? "That exact file is already on record." : `Indexed ${r.chunkCount} passages.`); (e.target as HTMLFormElement).reset(); router.refresh();
    } catch (x) { setErr(x instanceof GatewayError ? `${x.message} (${x.code})` : "Upload failed"); } finally { setBusy(false); }
  }
  return (
    <Card label={`${a.brand} ${a.modelNumber}`}>
      {editing ? (
        <form onSubmit={save} className="grid gap-3 sm:grid-cols-3">
          <label className="text-sm">Brand<input name="brand" defaultValue={a.brand} required className={field} /></label>
          <label className="text-sm">Model<input name="modelNumber" defaultValue={a.modelNumber} required className={field} /></label>
          <label className="text-sm">Location<input name="location" defaultValue={a.location ?? ""} className={field} /></label>
          <div className="flex gap-2 sm:col-span-3"><button className={btnPrimary} disabled={busy}>Save</button><button type="button" className={btnGhost} onClick={() => setEditing(false)}>Cancel</button></div>
        </form>
      ) : (
        <div className="flex flex-wrap items-start justify-between gap-2"><div><h2 className="font-semibold">{a.brand} {a.modelNumber}</h2><p className="text-sm text-muted">{a.category} · {a.location ?? "no location"}{a.serialNumber && " · serial on file (hidden)"}</p></div><button className={btnGhost} onClick={() => setEditing(true)}>Edit</button></div>
      )}
      <h3 className="mt-4 text-sm font-semibold">Documents</h3>
      {docs.length === 0 ? <p className="text-sm text-muted">None yet.</p> : <ul className="mt-1 space-y-1 text-sm">{docs.map((d) => <li key={d.id} className="flex flex-wrap items-center gap-2"><span>{d.originalFilename}</span><Pill value="" text={d.type.toLowerCase()} />{d.declaredModels.length > 0 ? <span className="text-xs text-muted">states model {d.declaredModels.join(", ")}{d.declaredModels.every((m) => m !== a.modelNumber.toUpperCase().replace(/[^A-Z0-9]/g, "")) && <strong className="text-warn"> · does not match this appliance</strong>}</span> : <span className="text-xs text-muted">model not stated</span>}{d.expiresOn && <span className="text-xs text-muted">expires {d.expiresOn.slice(0, 10)}</span>}</li>)}</ul>}
      <form onSubmit={upload} className="mt-3 flex flex-wrap items-end gap-2">
        <label className="text-sm">File (PDF or .txt)<input name="file" type="file" accept="application/pdf,text/plain,.pdf,.txt" required className="mt-1 block text-sm" /></label>
        <label className="text-sm">Type<select name="type" className={field}><option value="MANUAL">Manual</option><option value="WARRANTY">Warranty</option><option value="RECEIPT">Receipt</option><option value="OTHER">Other</option></select></label>
        <button className={btnGhost} disabled={busy}>Upload & index</button>
      </form>
      {msg && <p role="status" className="mt-2 text-sm text-ok">{msg}</p>}
      {err && <p role="alert" className="mt-2 text-sm text-danger">{err}</p>}
    </Card>
  );
}
