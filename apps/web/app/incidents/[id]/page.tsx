import Link from "next/link";
import { ApprovalCard } from "@/components/approvals/ApprovalCard";
import { EvidenceViewer } from "@/components/documents/EvidenceViewer";
import { IncidentActions } from "@/components/incidents/IncidentActions";
import { Timeline } from "@/components/incidents/Timeline";
import { Card, Disclosure, Pill, label, when } from "@/components/shared/ui";
import { apiGet } from "@/lib/api";
import type { IncidentDetail, IncidentEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function IncidentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const path = `/incidents/${id}`;
  const d = await apiGet<IncidentDetail>(`/api/v1/incidents/${id}`, path);
  const { events } = await apiGet<{ events: IncidentEvent[] }>(`/api/v1/incidents/${id}/events?limit=100`, path);
  const { incident: i } = d;
  const rr = d.repairRequests.at(-1);
  const pending = d.pendingApprovals.find((a) => a.status === "PENDING");
  const submitted = rr?.status === "SENT";
  const unknown = events.some((e) => e.eventType === "REPAIR_SUBMISSION_UNKNOWN_OUTCOME") && !submitted;
  const emergency = i.severity === "EMERGENCY" || i.severity === "HIGH";
  return (
    <div className="space-y-6">
      <div>
        <Link href="/" className="text-sm underline">
          ← Home
        </Link>
        <h1 className="mt-1 font-display text-3xl tracking-tight">{i.title}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Pill value={i.workflowStatus} />
          <Pill value={i.severity} text={`Risk: ${label(i.severity)}`} />
          {d.appliance && (
            <span className="text-sm text-muted">
              {d.appliance.brand} {d.appliance.modelNumber} · {d.appliance.location}
            </span>
          )}
        </div>
      </div>

      {emergency && (
        <Card tone="danger" label="Safety">
          <h2 className="font-semibold text-danger">Safety hazard flagged</h2>
          <p className="mt-1 text-sm">
            Move away from the hazard and contact local emergency services or a licensed professional. FixLoop will not draft or send repair
            requests while this is flagged, and it has not contacted anyone for you.
          </p>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <div className="space-y-6">
          <Card label="Summary">
            <h2 className="font-semibold">What was reported</h2>
            <p className="mt-1 text-sm">{i.description}</p>
            <p className="mt-2 text-xs text-muted">
              Opened {when(i.openedAt)} · last activity {when(i.lastActivityAt)}
            </p>
            {i.summary && (
              <p className="mt-2 text-sm">
                <strong>Resolution:</strong> {i.summary}
              </p>
            )}
          </Card>
          <Card label="Safety assessment">
            <h2 className="font-semibold">Safety assessment</h2>
            {d.latestSafety ? (
              <div className="mt-2 text-sm">
                <Pill value={d.latestSafety.riskLevel} />{" "}
                {d.latestSafety.identifiedHazards.length > 0 && (
                  <span className="ml-2">Flagged: {d.latestSafety.identifiedHazards.map(label).join(", ")}</span>
                )}
                <p className="mt-1 text-xs text-muted">
                  Deterministic rules {d.latestSafety.ruleVersion} · {when(d.latestSafety.completedAt)}
                </p>
              </div>
            ) : (
              <p className="mt-2 text-sm text-muted">Not assessed yet. Continue in the conversation on the home page.</p>
            )}
          </Card>

          <Card label="Repair request status">
            <h2 className="font-semibold">Repair request</h2>
            {!rr && <p className="mt-2 text-sm text-muted">No draft yet.</p>}
            {rr && (
              <div className="mt-2 space-y-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill value={rr.status} />
                  {submitted && rr.externalReference && (
                    <>
                      Reference <code>{rr.externalReference}</code>
                    </>
                  )}
                </div>
                {rr.status === "DRAFT" && <p>Draft created. Not sent.</p>}
                {rr.status === "PENDING_APPROVAL" && <p>Approval required. Nothing has been sent.</p>}
                {rr.status === "APPROVED" && (
                  <p>
                    {unknown
                      ? "Submission in doubt: the last attempt's outcome is unconfirmed. Ask FixLoop to “send it” to reconcile; it will check before resending."
                      : "Approved, submission not completed yet."}
                  </p>
                )}
                {submitted && (
                  <p>
                    Submitted successfully to the <strong>simulated</strong> provider. <strong>External completion is not verified</strong>{" "}
                    and no real technician was contacted.
                  </p>
                )}
              </div>
            )}
          </Card>
          {pending && rr && <ApprovalCard approvalId={pending.id} subject={rr.subject} body={rr.body} expiresAt={pending.expiresAt} />}
          {!emergency && <EvidenceViewer incidentId={i.id} defaultQuestion={d.appliance ? `${i.description}` : i.description} />}
        </div>
        <div className="space-y-6">
          <Card label="Case timeline">
            <h2 className="mb-3 font-semibold">Case timeline</h2>
            <Timeline events={events} />
          </Card>
          <IncidentActions incidentId={i.id} status={i.workflowStatus} />
        </div>
      </div>
      <Disclosure />
    </div>
  );
}
