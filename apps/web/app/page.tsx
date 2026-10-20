import Link from "next/link";
import { AlertTriangle, Refrigerator } from "lucide-react";
import { Card, Disclosure, Pill, label, when } from "@/components/shared/ui";
import { VoiceConsole } from "@/components/voice/VoiceConsole";
import { apiGet } from "@/lib/api";
import type { Appliance, Incident } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{ say?: string }> }) {
  const { say } = await searchParams;
  const [{ household }, { incidents }, { appliances }] = await Promise.all([
    apiGet<{ household: { name: string } }>("/api/v1/households/current"),
    apiGet<{ incidents: Incident[] }>("/api/v1/incidents?all=1"),
    apiGet<{ appliances: Appliance[] }>("/api/v1/appliances"),
  ]);
  const active = incidents.filter((i) => !["RESOLVED", "CANCELED"].includes(i.workflowStatus));
  const attention = active.filter((i) => ["ACTION_PENDING", "SAFETY_ESCALATED"].includes(i.workflowStatus));
  return (
    <div className="grid gap-6 lg:grid-cols-[1.15fr_1fr]">
      <div className="space-y-6">
        <div>
          <p className="text-sm text-muted">{household.name}</p>
          <h1 className="font-display text-3xl tracking-tight">Your home has problems. FixLoop remembers how to solve them.</h1>
        </div>
        {attention.length > 0 && (
          <Card tone="warn" label="Needs your attention">
            <h2 className="flex items-center gap-2 font-semibold"><AlertTriangle size={18} aria-hidden /> Needs your attention</h2>
            <ul className="mt-2 space-y-2">{attention.map((i) => <li key={i.id} className="flex flex-wrap items-center gap-2 text-sm"><Link className="font-medium underline" href={`/incidents/${i.id}`}>{i.title}</Link><Pill value={i.workflowStatus} /></li>)}</ul>
          </Card>
        )}
        <Card label="Active incidents">
          <h2 className="font-semibold">Active incidents</h2>
          {active.length === 0 ? <p className="mt-2 text-sm text-muted">Nothing open. Describe a problem and FixLoop will start a case.</p> : (
            <ul className="mt-3 divide-y divide-line">{active.map((i) => <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2"><Link href={`/incidents/${i.id}`} className="text-sm font-medium underline">{i.title}</Link><span className="flex items-center gap-2"><Pill value={i.workflowStatus} /><Pill value={i.severity} text={`Risk: ${label(i.severity)}`} /></span></li>)}</ul>
          )}
        </Card>
        <div className="grid gap-6 sm:grid-cols-2">
          <Card label="Appliances">
            <h2 className="font-semibold">Appliances</h2>
            <ul className="mt-2 space-y-2">{appliances.map((a) => <li key={a.id} className="flex items-center gap-2 text-sm"><Refrigerator size={16} aria-hidden /> {a.brand} {a.modelNumber} <span className="text-muted">· {a.location ?? a.category}</span></li>)}</ul>
            <Link className="mt-3 inline-block text-sm underline" href="/appliances">Manage appliances and documents</Link>
          </Card>
          <Card label="Recent activity">
            <h2 className="font-semibold">Recent activity</h2>
            {incidents.length === 0 ? <p className="mt-2 text-sm text-muted">No activity yet.</p> : <ul className="mt-2 space-y-2 text-sm">{incidents.slice(0, 4).map((i) => <li key={i.id}><Link href={`/incidents/${i.id}`} className="underline">{i.title}</Link><div className="text-xs text-muted">{label(i.workflowStatus)} · {when(i.lastActivityAt)}</div></li>)}</ul>}
          </Card>
        </div>
        <Disclosure />
      </div>
      <VoiceConsole suggested={say} />
    </div>
  );
}
