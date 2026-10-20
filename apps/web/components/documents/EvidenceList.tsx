import { Card, Pill } from "@/components/shared/ui";

export interface EvidenceItemView { claim: string; status: string; filename: string; page: number; modelMatch: boolean | null; uncertainties: string[]; expiresOn?: string | null }

export function EvidenceList({ overall, items }: { overall: string; items: EvidenceItemView[] }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm">Overall <Pill value={overall} /></div>
      {items.length === 0 && <p className="text-sm text-muted">No supporting text was found in your documents. FixLoop will not guess.</p>}
      {items.map((e, i) => (
        <Card key={i} tone={e.status === "VERIFIED" ? "ok" : e.status === "CONFLICTING" ? "danger" : "warn"}>
          <blockquote className="text-sm leading-relaxed">“{e.claim}”</blockquote>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <Pill value={e.status} />
            <span>{e.filename} · page {e.page}</span>
            <span>{e.modelMatch === true ? "Model matches your appliance" : e.modelMatch === false ? "Different product model" : "Model not stated"}</span>
          </div>
          {e.uncertainties.length > 0 && <ul className="mt-2 list-disc pl-5 text-xs text-muted">{e.uncertainties.map((u, j) => <li key={j}>{u}</li>)}</ul>}
        </Card>
      ))}
    </div>
  );
}
