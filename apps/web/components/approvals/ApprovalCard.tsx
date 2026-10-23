"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, Pill, btnDanger, btnGhost, btnPrimary, when } from "@/components/shared/ui";
import { gw, GatewayError } from "@/lib/client";

/** Human decision point. The agent can't approve; only this button (user-scope session) can. */
export function ApprovalCard({
  approvalId,
  subject,
  body,
  recipientAddress,
  expiresAt,
  status: initial = "PENDING",
  onDecided,
}: {
  approvalId: string;
  subject: string;
  body: string;
  recipientAddress: string | null;
  expiresAt: string | null;
  status?: string;
  onDecided?: (s: string) => void;
}) {
  const [status, setStatus] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  async function decide(kind: "approve" | "reject") {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await gw<{ approval: { status: string } }>(`approvals/${approvalId}/${kind}`, { method: "POST" });
      setStatus(r.approval.status);
      onDecided?.(r.approval.status);
      router.refresh();
    } catch (e) {
      setError(e instanceof GatewayError ? `${e.message} (${e.code})` : "Could not record your decision");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card tone="warn" label="Repair request awaiting approval">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Review before anything is sent</h3>
        <Pill value={status} />
      </div>
      <p className="mt-1 text-sm font-medium">{subject}</p>
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-surface p-3 text-xs leading-relaxed">
        {body}
      </pre>
      <p className="mt-2 text-xs text-muted">
        {recipientAddress ? (
          <>
            Recipient: <strong>{recipientAddress}</strong> (real email). Approving emails exactly this text once.
          </>
        ) : (
          <>
            Recipient: repair technician (<strong>simulated provider</strong>). Approving submits exactly this text once.
          </>
        )}{" "}
        {expiresAt && status === "PENDING" && <>Expires {when(expiresAt)}.</>}
      </p>
      {status === "PENDING" && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button className={btnPrimary} disabled={busy} onClick={() => decide("approve")}>
            Approve this request
          </button>
          <button className={btnGhost} disabled={busy} onClick={() => decide("reject")}>
            Cancel / reject
          </button>
        </div>
      )}
      {status === "APPROVED" && (
        <p className="mt-3 text-sm">
          Approved. Say or type <strong>“send it”</strong> to submit.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </Card>
  );
}
export { btnDanger };
