import { createHash } from "node:crypto";
import type { ProviderFailureKind } from "@fixloop/domain";
import type { Db } from "../db.js";

export class ProviderError extends Error {
  constructor(readonly kind: ProviderFailureKind, message: string) { super(message); }
}

export interface ProviderReceipt { reference: string; receivedAt: Date }
export interface RepairProvider {
  /** Provider-native idempotency: the same idempotencyKey never creates a second request. */
  submit(req: { idempotencyKey: string; subject: string; body: string }): Promise<ProviderReceipt & { duplicate: boolean }>;
  /** Read back by idempotency key; null if the provider has no such request. */
  lookup(idempotencyKey: string): Promise<ProviderReceipt | null>;
}

export type Fault = "submit:fail_before" | "submit:timeout_after" | "submit:reject" | "lookup:fail";

/**
 * Deterministic stand-in for an external recipient system. It persists to its own table
 * (ProviderRequest) and NEVER contacts a real technician. Faults are consumed once, in order.
 */
export class SimulatedRepairProvider implements RepairProvider {
  private faults: Fault[] = [];
  constructor(private readonly db: Db) {}

  script(...faults: Fault[]) { this.faults = [...faults]; }
  clearFaults() { this.faults = []; }
  private take(op: "submit" | "lookup"): Fault | undefined {
    const i = this.faults.findIndex((f) => f.startsWith(`${op}:`));
    return i === -1 ? undefined : this.faults.splice(i, 1)[0];
  }
  static referenceFor(key: string) { return "SIM-" + createHash("sha256").update(key).digest("hex").slice(0, 10).toUpperCase(); }

  async submit(req: { idempotencyKey: string; subject: string; body: string }) {
    const fault = this.take("submit");
    if (fault === "submit:fail_before") throw new ProviderError("NOT_SENT", "connection reset before request was sent");
    if (fault === "submit:reject") throw new ProviderError("PERMANENT", "provider rejected the request");
    const before = await this.db.providerRequest.findUnique({ where: { idempotencyKey: req.idempotencyKey } });
    const row = before ?? await this.db.providerRequest.upsert({
      where: { idempotencyKey: req.idempotencyKey }, update: {},
      create: { idempotencyKey: req.idempotencyKey, reference: SimulatedRepairProvider.referenceFor(req.idempotencyKey), subject: req.subject, body: req.body },
    });
    if (fault === "submit:timeout_after") throw new ProviderError("AMBIGUOUS", "timed out waiting for response (request may have been processed)");
    return { reference: row.reference, receivedAt: row.receivedAt, duplicate: before !== null };
  }

  async lookup(idempotencyKey: string) {
    if (this.take("lookup") === "lookup:fail") throw new ProviderError("AMBIGUOUS", "provider status endpoint unavailable");
    const row = await this.db.providerRequest.findUnique({ where: { idempotencyKey } });
    return row ? { reference: row.reference, receivedAt: row.receivedAt } : null;
  }
}
