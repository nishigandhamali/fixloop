import { actionPayloadHash, backoffDelayMs } from "@fixloop/domain";
import { Prisma, type ExecStatus } from "@prisma/client";
import { createHash } from "node:crypto";
import { ProviderError, type ProviderReceipt, type RepairProvider } from "../../adapters/provider.js";
import type { Db } from "../../db.js";
import { AppError, forbidden, notFound } from "../../errors.js";
import type { Principal } from "../../principal.js";
import type { IncidentService } from "../incidents/incident-service.js";
import { payloadOf } from "./repair-service.js";

export interface RetryConfig {
  maxAttempts: number;
  baseMs: number;
  capMs: number;
  leaseMs: number;
}
export const DEFAULT_RETRY: RetryConfig = { maxAttempts: 3, baseMs: 200, capMs: 2000, leaseMs: 30_000 };

export interface ExecutionResult {
  status: ExecStatus;
  executionId: string;
  repairRequestId: string;
  providerReference: string | null;
  replayed: boolean;
  reconciled: boolean;
  attempts: number;
  externalCompletionVerified: false;
  provider: "SIMULATED_PROVIDER";
  message: string;
}

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const RECLAIMABLE: ExecStatus[] = ["PENDING", "FAILED_RETRYABLE", "UNKNOWN_OUTCOME"];

/**
 * Side-effect execution. Invariants:
 *  - nothing is sent without an APPROVED, unexpired approval whose payload hash still matches;
 *  - one downstream request per repair request (provider-native idempotency key = RepairRequest.idempotencyKey);
 *  - ambiguous outcomes are reconciled by read-back before any retry;
 *  - SUCCEEDED is recorded only after the provider acknowledged (submit returned or lookup found it).
 */
export class ExecutionService {
  constructor(
    private readonly db: Db,
    private readonly incidents: IncidentService,
    private readonly provider: RepairProvider,
    private readonly retry: RetryConfig = DEFAULT_RETRY,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(p: Principal, input: { incidentId: string; approvalId: string; idempotencyKey: string }): Promise<ExecutionResult> {
    if (p.role === "VIEWER") throw forbidden();
    const approval = await this.db.approval.findUnique({ where: { id: input.approvalId }, include: { incident: true } });
    if (!approval || approval.incidentId !== input.incidentId || approval.incident.householdId !== p.householdId)
      throw notFound("approval");
    const draft = await this.db.repairRequest.findUnique({ where: { id: approval.actionRefId } });
    if (!draft) throw notFound("draft");

    const requestHash = createHash("sha256").update(`${approval.id}|${approval.incidentId}`).digest("hex");
    const exec = await this.openExecution(p, input, requestHash);
    const done = (e: { id: string; resultSummary: Prisma.JsonValue | null }) =>
      ({ ...(e.resultSummary as object), replayed: true }) as ExecutionResult;
    if (exec.status === "SUCCEEDED" || exec.status === "FAILED_PERMANENT") return done(exec);

    const firstAttempt = exec.status === "PENDING";
    const stale = exec.status === "RUNNING" && exec.startedAt.getTime() < this.now().getTime() - this.retry.leaseMs;
    const claim = await this.db.toolExecution.updateMany({
      where: { id: exec.id, OR: [{ status: { in: RECLAIMABLE } }, ...(stale ? [{ status: "RUNNING" as const }] : [])] },
      data: { status: "RUNNING", startedAt: this.now() },
    });
    if (claim.count !== 1)
      throw new AppError("EXECUTION_IN_PROGRESS", "This execution is already running; retry shortly with the same idempotency key", 409);

    try {
      this.validate(approval, draft, firstAttempt);
      if (approval.incident.workflowStatus !== "ACTION_PENDING" && approval.incident.workflowStatus !== "IN_PROGRESS")
        throw new AppError("ILLEGAL_TRANSITION", `Incident is ${approval.incident.workflowStatus}`, 409);
    } catch (e) {
      await this.db.toolExecution.update({
        where: { id: exec.id },
        data: { status: "PENDING", errorCode: e instanceof AppError ? e.code : "VALIDATION" },
      });
      throw e;
    }

    try {
      return await this.run(p, exec.id, requestHash, approval.id, draft, !firstAttempt);
    } catch (e) {
      // Unexpected failure after the claim: we cannot know what happened externally.
      await this.db.toolExecution
        .update({ where: { id: exec.id }, data: { status: "UNKNOWN_OUTCOME", errorCode: "UNEXPECTED" } })
        .catch(() => undefined);
      throw e;
    }
  }

  private async openExecution(p: Principal, input: { incidentId: string; idempotencyKey: string }, requestHash: string) {
    const key = {
      toolName_actorId_idempotencyKey: { toolName: "execute_approved_action", actorId: p.userId, idempotencyKey: input.idempotencyKey },
    };
    let exec = await this.db.toolExecution.findUnique({ where: key });
    if (!exec) {
      try {
        exec = await this.db.toolExecution.create({
          data: {
            toolName: "execute_approved_action",
            actorId: p.userId,
            incidentId: input.incidentId,
            requestHash,
            idempotencyKey: input.idempotencyKey,
          },
        });
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
        exec = await this.db.toolExecution.findUniqueOrThrow({ where: key });
      }
    }
    if (exec.requestHash !== requestHash)
      throw new AppError("IDEMPOTENCY_KEY_REUSE", "This idempotency key was already used for a different action", 422);
    return exec;
  }

  private validate(
    approval: { status: string; expiresAt: Date; actionPayloadHash: string },
    draft: Parameters<typeof payloadOf>[0],
    firstAttempt: boolean,
  ) {
    switch (approval.status) {
      case "APPROVED":
        break;
      case "PENDING":
        throw new AppError("APPROVAL_REQUIRED", "The user has not approved this action yet", 403);
      case "REJECTED":
        throw new AppError("APPROVAL_REJECTED", "The user rejected this action", 409);
      case "EXPIRED":
        throw new AppError("APPROVAL_EXPIRED", "Approval expired; request a new one", 409);
      default:
        throw new AppError("APPROVAL_ALREADY_CONSUMED", "This approval was already used", 409);
    }
    // Expiry only gates the START of an execution; a resumed attempt began while the approval was valid.
    if (firstAttempt && approval.expiresAt <= this.now())
      throw new AppError("APPROVAL_EXPIRED", "Approval expired; request a new one", 409);
    if (actionPayloadHash(payloadOf(draft)) !== approval.actionPayloadHash)
      throw new AppError("PAYLOAD_CHANGED", "The draft changed after it was approved; request a new approval", 409);
  }

  private async run(
    p: Principal,
    execId: string,
    _requestHash: string,
    approvalId: string,
    draft: Parameters<typeof payloadOf>[0] & { idempotencyKey: string; subject: string; body: string; id: string },
    reconcileFirst: boolean,
  ): Promise<ExecutionResult> {
    let attempts = 0,
      reconciled = false;
    let receipt: ProviderReceipt | null = null;
    let outcome: "SUCCEEDED" | "FAILED_RETRYABLE" | "FAILED_PERMANENT" | "UNKNOWN_OUTCOME" = "FAILED_RETRYABLE";
    let lastError = "";

    const tryLookup = async (): Promise<"found" | "absent" | "unavailable"> => {
      try {
        const r = await this.provider.lookup(draft.idempotencyKey);
        if (r) {
          receipt = r;
          reconciled = true;
          return "found";
        }
        return "absent";
      } catch (e) {
        if (e instanceof ProviderError) {
          lastError = e.message;
          return "unavailable";
        }
        throw e;
      }
    };

    if (reconcileFirst && (await tryLookup()) === "unavailable") outcome = "UNKNOWN_OUTCOME";
    else if (!receipt) {
      for (attempts = 1; attempts <= this.retry.maxAttempts; attempts++) {
        try {
          const r = await this.provider.submit({ idempotencyKey: draft.idempotencyKey, subject: draft.subject, body: draft.body });
          receipt = r;
          break;
        } catch (e) {
          if (!(e instanceof ProviderError)) throw e;
          lastError = e.message;
          if (e.kind === "PERMANENT") {
            outcome = "FAILED_PERMANENT";
            break;
          }
          if (e.kind === "AMBIGUOUS") {
            // Never retry blind: read back first.
            const r = await tryLookup();
            if (r === "found") break;
            if (r === "unavailable") {
              outcome = "UNKNOWN_OUTCOME";
              break;
            }
          }
          if (attempts < this.retry.maxAttempts) await sleep(backoffDelayMs(attempts, this.retry.baseMs, this.retry.capMs));
        }
      }
      attempts = Math.min(attempts, this.retry.maxAttempts);
    }
    if (receipt) outcome = "SUCCEEDED";

    const base = {
      executionId: execId,
      repairRequestId: draft.id,
      replayed: false,
      reconciled,
      attempts,
      externalCompletionVerified: false as const,
      provider: "SIMULATED_PROVIDER" as const,
    };
    if (outcome === "SUCCEEDED" && receipt) {
      const ref = (receipt as ProviderReceipt).reference;
      const result: ExecutionResult = {
        ...base,
        status: "SUCCEEDED",
        providerReference: ref,
        message: "Submitted to the simulated provider. A real technician has NOT been contacted and external completion is not verified.",
      };
      await this.db.$transaction(async (tx) => {
        await tx.repairRequest.updateMany({
          where: { id: draft.id, status: { not: "SENT" } },
          data: { status: "SENT", externalReference: ref, sentAt: this.now() },
        });
        await tx.approval.updateMany({
          where: { id: approvalId, status: "APPROVED" },
          data: { status: "CONSUMED", consumedAt: this.now() },
        });
        const incidentId = (await tx.repairRequest.findUniqueOrThrow({ where: { id: draft.id } })).incidentId;
        const done = await tx.incidentEvent.findFirst({ where: { incidentId, idempotencyKey: `submit:${draft.id}` } });
        if (!done) {
          await this.incidents.event(
            tx,
            p,
            incidentId,
            "REPAIR_REQUEST_SUBMITTED",
            {
              repairRequestId: draft.id,
              providerReference: ref,
              provider: "SIMULATED_PROVIDER",
              reconciled,
              externalCompletionVerified: false,
            },
            "EXTERNAL",
            `submit:${draft.id}`,
          );
          await this.incidents.transition(tx, p, incidentId, "IN_PROGRESS", "IN_PROGRESS", { repairRequestId: draft.id });
        }
        await tx.toolExecution.update({
          where: { id: execId },
          data: {
            status: "SUCCEEDED",
            completedAt: this.now(),
            errorCode: null,
            resultSummary: result as unknown as Prisma.InputJsonValue,
          },
        });
      });
      return result;
    }

    const message = {
      FAILED_PERMANENT: "The provider rejected the request. Nothing was sent.",
      UNKNOWN_OUTCOME:
        "The request may or may not have reached the provider and its status could not be confirmed. Nothing will be resent until this is reconciled.",
      FAILED_RETRYABLE: "The request was not sent after several attempts. It is safe to try again.",
    }[outcome as "FAILED_PERMANENT" | "UNKNOWN_OUTCOME" | "FAILED_RETRYABLE"];
    const result: ExecutionResult = { ...base, status: outcome, providerReference: null, message };
    const incidentId = (await this.db.repairRequest.findUniqueOrThrow({ where: { id: draft.id } })).incidentId;
    await this.db.$transaction(async (tx) => {
      if (outcome === "FAILED_PERMANENT") await tx.repairRequest.update({ where: { id: draft.id }, data: { status: "FAILED" } });
      await this.incidents.event(
        tx,
        p,
        incidentId,
        `REPAIR_SUBMISSION_${outcome}`,
        { repairRequestId: draft.id, attempts, detail: lastError },
        "EXTERNAL",
      );
      await tx.toolExecution.update({
        where: { id: execId },
        data: {
          status: outcome,
          errorCode: outcome,
          completedAt: outcome === "FAILED_PERMANENT" ? this.now() : null,
          resultSummary: result as unknown as Prisma.InputJsonValue,
        },
      });
    });
    return result;
  }
}
