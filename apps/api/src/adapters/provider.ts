import { createHash } from "node:crypto";
import type { ProviderFailureKind } from "@fixloop/domain";
import type { Db } from "../db.js";

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderFailureKind,
    message: string,
  ) {
    super(message);
  }
}

export interface ProviderReceipt {
  reference: string;
  receivedAt: Date;
}
export type ProviderName = "SIMULATED_PROVIDER" | "EMAIL";
export interface SubmitRequest {
  idempotencyKey: string;
  recipientAddress: string | null;
  subject: string;
  body: string;
}
export interface RepairProvider {
  readonly name: ProviderName;
  /** Provider-native idempotency: the same idempotencyKey never creates a second request. */
  submit(req: SubmitRequest): Promise<ProviderReceipt>;
  /** Read back by idempotency key; null if the provider has no record of such a request. */
  lookup(idempotencyKey: string): Promise<ProviderReceipt | null>;
}

export type Fault = "submit:fail_before" | "submit:timeout_after" | "submit:reject" | "lookup:fail";

/**
 * Deterministic stand-in for an external recipient system. It persists to its own table
 * (ProviderRequest) and NEVER contacts a real technician. Faults are consumed once, in order.
 */
export class SimulatedRepairProvider implements RepairProvider {
  readonly name = "SIMULATED_PROVIDER" as const;
  private faults: Fault[] = [];
  constructor(private readonly db: Db) {}

  script(...faults: Fault[]) {
    this.faults = [...faults];
  }
  clearFaults() {
    this.faults = [];
  }
  private take(op: "submit" | "lookup"): Fault | undefined {
    const i = this.faults.findIndex((f) => f.startsWith(`${op}:`));
    return i === -1 ? undefined : this.faults.splice(i, 1)[0];
  }
  static referenceFor(key: string) {
    return "SIM-" + createHash("sha256").update(key).digest("hex").slice(0, 10).toUpperCase();
  }

  async submit(req: SubmitRequest) {
    const fault = this.take("submit");
    if (fault === "submit:fail_before") throw new ProviderError("NOT_SENT", "connection reset before request was sent");
    if (fault === "submit:reject") throw new ProviderError("PERMANENT", "provider rejected the request");
    const before = await this.db.providerRequest.findUnique({ where: { idempotencyKey: req.idempotencyKey } });
    const row =
      before ??
      (await this.db.providerRequest.upsert({
        where: { idempotencyKey: req.idempotencyKey },
        update: {},
        create: {
          idempotencyKey: req.idempotencyKey,
          reference: SimulatedRepairProvider.referenceFor(req.idempotencyKey),
          subject: req.subject,
          body: req.body,
        },
      }));
    if (fault === "submit:timeout_after")
      throw new ProviderError("AMBIGUOUS", "timed out waiting for response (request may have been processed)");
    return { reference: row.reference, receivedAt: row.receivedAt, duplicate: before !== null };
  }

  async lookup(idempotencyKey: string) {
    if (this.take("lookup") === "lookup:fail") throw new ProviderError("AMBIGUOUS", "provider status endpoint unavailable");
    const row = await this.db.providerRequest.findUnique({ where: { idempotencyKey } });
    return row ? { reference: row.reference, receivedAt: row.receivedAt } : null;
  }
}

export interface EmailProviderConfig {
  apiKey: string;
  from: string;
  /** Request timeout; an elapsed timeout is AMBIGUOUS because the email service may already have accepted the message. */
  timeoutMs?: number;
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Sends the approved text as a real email through the Resend HTTP API.
 * The repair request's idempotency key is sent as the service's own Idempotency-Key, so a retry of an
 * ambiguous attempt returns the original result instead of emailing twice (the service keeps keys for 24 hours).
 */
export class EmailRepairProvider implements RepairProvider {
  readonly name = "EMAIL" as const;
  constructor(private readonly cfg: EmailProviderConfig) {}

  async submit(req: SubmitRequest): Promise<ProviderReceipt> {
    if (!req.recipientAddress) throw new ProviderError("PERMANENT", "The repair request has no recipient address");
    let res: Response;
    try {
      res = await (this.cfg.fetchImpl ?? fetch)(this.cfg.endpoint ?? "https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.cfg.apiKey}`,
          "content-type": "application/json",
          "idempotency-key": req.idempotencyKey,
        },
        body: JSON.stringify({ from: this.cfg.from, to: [req.recipientAddress], subject: req.subject, text: req.body }),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 10_000),
      });
    } catch {
      throw new ProviderError("AMBIGUOUS", "No response from the email service (the email may have been accepted)");
    }
    const payload = (await res.json().catch(() => null)) as { id?: unknown; message?: unknown } | null;
    if (res.ok) {
      if (typeof payload?.id !== "string") throw new ProviderError("AMBIGUOUS", "The email service response could not be read");
      return { reference: payload.id, receivedAt: new Date() };
    }
    // Throttling, in-flight duplicates and server errors may or may not have sent; retrying with the same key is safe.
    if (res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500)
      throw new ProviderError("AMBIGUOUS", `The email service was unavailable (HTTP ${res.status})`);
    throw new ProviderError(
      "PERMANENT",
      `The email service rejected the request (HTTP ${res.status}${typeof payload?.message === "string" ? `: ${payload.message}` : ""})`,
    );
  }

  /** The email service cannot be queried by idempotency key; the reconciliation is the idempotent retry in submit(). */
  async lookup(): Promise<ProviderReceipt | null> {
    return null;
  }
}
