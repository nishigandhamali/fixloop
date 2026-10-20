import { AddAppliance, ApplianceCard } from "@/components/documents/ApplianceManager";
import { apiGet } from "@/lib/api";
import type { Appliance, DocumentMeta } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function Appliances() {
  const [{ appliances }, { documents }] = await Promise.all([apiGet<{ appliances: Appliance[] }>("/api/v1/appliances", "/appliances"), apiGet<{ documents: DocumentMeta[] }>("/api/v1/documents", "/appliances")]);
  return (
    <div className="space-y-6">
      <h1 className="font-display text-3xl tracking-tight">Appliance library</h1>
      <p className="text-sm text-muted">Documents are indexed for search. FixLoop only treats a document as evidence for an appliance when the model number it states matches.</p>
      {appliances.map((a) => <ApplianceCard key={a.id} a={a} docs={documents.filter((d) => d.applianceId === a.id)} />)}
      <AddAppliance />
    </div>
  );
}
