import { createHash } from "node:crypto";

export interface ActionPayload {
  actionType: "SUBMIT_REPAIR_REQUEST";
  incidentId: string;
  repairRequestId: string;
  recipientType: string;
  recipientAddress: string | null;
  subject: string;
  body: string;
}

const canonical = (o: Record<string, unknown>) =>
  JSON.stringify(
    Object.keys(o)
      .sort()
      .map((k) => [k, o[k]]),
  );

/** Hash of EXACTLY what the human saw and approved. Any change to the draft invalidates the approval. */
export function actionPayloadHash(p: ActionPayload): string {
  return createHash("sha256")
    .update(canonical({ ...p }))
    .digest("hex");
}

/** Exponential backoff with full jitter. `rand` in [0,1) is injectable for tests. attempt starts at 1. */
export function backoffDelayMs(attempt: number, baseMs: number, capMs: number, rand: () => number = Math.random): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** (attempt - 1));
  return Math.floor(rand() * ceiling);
}

export type ProviderFailureKind = "NOT_SENT" | "AMBIGUOUS" | "PERMANENT";
