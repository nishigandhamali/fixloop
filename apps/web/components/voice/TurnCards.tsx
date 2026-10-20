import Link from "next/link";
import { Card, Pill, label, when } from "@/components/shared/ui";
import { ApprovalCard } from "@/components/approvals/ApprovalCard";
import { EvidenceList } from "@/components/documents/EvidenceList";
import type { Card as TCard } from "@/lib/types";

export function TurnCards({ cards, onChoose, onDecided }: { cards: TCard[]; onChoose?: (title: string) => void; onDecided?: (s: string) => void }) {
  return (
    <div className="mt-3 space-y-3">
      {cards.map((c, i) => {
        switch (c.type) {
          case "emergency":
            return (
              <Card key={i} tone="danger" label="Safety guidance">
                <h3 className="font-semibold text-danger">Safety first</h3>
                <p className="mt-1 text-sm leading-relaxed">{c.guidance}</p>
                {c.hazards.length > 0 && <p className="mt-2 text-xs">Flagged: {c.hazards.map(label).join(", ")}</p>}
              </Card>
            );
          case "safety_questions":
            return (
              <Card key={i} tone="info" label="Safety questions"><h3 className="text-sm font-semibold">Quick safety check</h3><ol className="mt-1 list-decimal pl-5 text-sm">{c.questions.map((q) => <li key={q}>{q}</li>)}</ol></Card>
            );
          case "evidence":
            return <Card key={i} label="Evidence from your documents"><h3 className="mb-2 text-sm font-semibold">From your documents</h3><EvidenceList overall={c.overallStatus} items={c.items} /></Card>;
          case "approval":
            return <ApprovalCard key={c.approvalId + i} approvalId={c.approvalId} subject={c.subject} body={c.body} expiresAt={c.expiresAt} status={c.status} onDecided={onDecided} />;
          case "status":
            return (
              <Card key={i} label="Case status">
                <div className="flex flex-wrap items-center gap-2"><Link className="font-semibold underline" href={`/incidents/${c.incidentId}`}>{c.title}</Link><Pill value={c.workflowStatus} /><Pill value={c.severity} text={`Risk: ${label(c.severity)}`} /></div>
                {c.repair && <p className="mt-2 text-sm">Repair request: <Pill value={c.repair.status} />{c.repair.reference && <> reference <code>{c.repair.reference}</code> (simulated; completion not verified)</>}</p>}
                <ul className="mt-2 text-xs text-muted">{c.lastEvents.map((e, j) => <li key={j}>{label(e.eventType)} · {when(e.timestamp)}</li>)}</ul>
              </Card>
            );
          case "execution":
            return (
              <Card key={i} tone={c.status === "SUCCEEDED" ? "ok" : "warn"} label="Submission result">
                <div className="flex items-center gap-2"><Pill value={c.status} />{c.providerReference && <code className="text-sm">{c.providerReference}</code>}</div>
                <p className="mt-2 text-sm">{c.message}</p><p className="mt-1 text-xs text-muted">External completion is not verified.</p>
              </Card>
            );
          case "choice":
            return (
              <Card key={i} tone="info" label="Choose a case"><ul className="space-y-2">{c.incidents.map((n) => <li key={n.id} className="flex items-center justify-between gap-2 text-sm"><span>{n.title}</span>{onChoose && <button className="rounded-lg border border-line px-3 py-1 text-xs font-semibold" onClick={() => onChoose(n.title)}>This one</button>}<Link className="text-xs underline" href={`/incidents/${n.id}`}>Open</Link></li>)}</ul></Card>
            );
        }
      })}
    </div>
  );
}
