import { actionPayloadHash, type ActionPayload } from "@fixloop/domain";
import { Prisma, type Approval, type RepairRequest } from "@prisma/client";
import { createHash } from "node:crypto";
import type { Db } from "../../db.js";
import { AppError, forbidden, notFound } from "../../errors.js";
import type { Principal } from "../../principal.js";
import type { EvidenceService } from "../documents/evidence-service.js";
import type { IncidentService } from "../incidents/incident-service.js";

export const RECIPIENT_TYPES = ["REPAIR_TECHNICIAN", "MANUFACTURER_SUPPORT", "LANDLORD"] as const;
export type RecipientType = (typeof RECIPIENT_TYPES)[number];
export const APPROVAL_TTL_MS = 15 * 60_000;

export const payloadOf = (r: RepairRequest): ActionPayload => ({
  actionType: "SUBMIT_REPAIR_REQUEST",
  incidentId: r.incidentId,
  repairRequestId: r.id,
  recipientType: r.recipientType,
  recipientAddress: r.recipientAddress,
  subject: r.subject,
  body: r.body,
});
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Drafting, approval request, and human approval decisions. Nothing here talks to the provider. */
export class RepairService {
  constructor(
    private readonly db: Db,
    private readonly incidents: IncidentService,
    private readonly evidence: EvidenceService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private requireWriter(p: Principal) {
    if (p.role === "VIEWER") throw forbidden();
  }
  private async loadIncident(p: Principal, id: string) {
    const inc = await this.db.incident.findUnique({ where: { id }, include: { appliance: true } });
    if (!inc || inc.householdId !== p.householdId) throw notFound("incident");
    return inc;
  }

  async draft(p: Principal, input: { incidentId: string; recipientType: RecipientType; messageContext?: string | undefined }) {
    this.requireWriter(p);
    const inc = await this.loadIncident(p, input.incidentId);
    if (inc.severity === "HIGH" || inc.severity === "EMERGENCY" || inc.workflowStatus === "SAFETY_ESCALATED")
      throw new AppError(
        "SAFETY_BLOCKED",
        "This incident was flagged as a safety hazard. Repair requests are not drafted until the hazard is addressed.",
        409,
      );
    if (inc.safetyStatus !== "CLEARED")
      throw new AppError("SAFETY_NOT_CLEARED", "Complete the safety assessment before drafting a repair request.", 409);
    if (!["READY_FOR_EVIDENCE", "EVIDENCE_REVIEW"].includes(inc.workflowStatus))
      throw new AppError(
        inc.workflowStatus === "ACTION_PENDING" ? "ACTION_ALREADY_PENDING" : "ILLEGAL_TRANSITION",
        `Cannot draft a repair request while the incident is ${inc.workflowStatus}`,
        409,
      );
    const sent = await this.db.repairRequest.findFirst({ where: { incidentId: inc.id, status: "SENT" } });
    if (sent) throw new AppError("REPAIR_ALREADY_SUBMITTED", "A repair request was already submitted for this incident", 409);

    // Only VERIFIED, model-matched facts are quoted; each carries its citation.
    const ev = await this.evidence.findForIncident(p, { incidentId: inc.id, question: inc.description });
    const facts = ev.evidence.filter((e) => e.verificationStatus === "VERIFIED").slice(0, 3);
    const a = inc.appliance;
    const body = [
      "Service request drafted by FixLoop (concept simulation: no real technician is contacted).",
      "",
      a
        ? `Appliance: ${a.brand} ${a.modelNumber} (${a.category.toLowerCase()})${a.location ? `, ${a.location}` : ""}`
        : "Appliance: not specified",
      `Reported problem: ${inc.description}`,
      `Safety screening: completed, no immediate hazard reported (${inc.severity}).`,
      ...(input.messageContext ? ["", `Owner note: ${input.messageContext}`] : []),
      "",
      facts.length
        ? "Information from the owner's documents (verified against this model):"
        : "No manufacturer documentation could be verified for this model.",
      ...facts.map((f) => `- "${f.claim}" (${f.sources[0]!.filename}, page ${f.sources[0]!.pageNumber})`),
      "",
      "Requested: inspection and a repair estimate. Please contact the owner to schedule.",
    ].join("\n");
    const subject = `Repair request: ${a ? `${a.brand} ${a.modelNumber} ` : ""}${inc.title}`.slice(0, 200);
    const idempotencyKey = `draft:${inc.id}:${input.recipientType}:${sha(subject + "\n" + body).slice(0, 24)}`;

    return this.db.$transaction(async (tx) => {
      const existing = await tx.repairRequest.findUnique({ where: { idempotencyKey } });
      if (existing && existing.status !== "CANCELED" && existing.status !== "FAILED") return { draft: existing, replayed: true };
      const draft = existing
        ? await tx.repairRequest.update({ where: { id: existing.id }, data: { status: "DRAFT" } })
        : await tx.repairRequest.create({
            data: { incidentId: inc.id, recipientType: input.recipientType, subject, body, status: "DRAFT", idempotencyKey },
          });
      await this.incidents.event(
        tx,
        p,
        inc.id,
        "REPAIR_DRAFTED",
        { repairRequestId: draft.id, recipientType: input.recipientType, citedFacts: facts.length },
        "TOOL",
      );
      if (inc.workflowStatus === "READY_FOR_EVIDENCE")
        await this.incidents.transition(tx, p, inc.id, "EVIDENCE_REVIEW", "EVIDENCE_REVIEWED", { repairRequestId: draft.id });
      return { draft, replayed: false };
    });
  }

  async requestApproval(p: Principal, input: { incidentId: string; actionType: "SUBMIT_REPAIR_REQUEST"; draftId: string }) {
    this.requireWriter(p);
    const inc = await this.loadIncident(p, input.incidentId);
    const draft = await this.db.repairRequest.findUnique({ where: { id: input.draftId } });
    if (!draft || draft.incidentId !== inc.id) throw notFound("draft");
    return this.db.$transaction(async (tx) => {
      const live = await tx.approval.findFirst({
        where: { incidentId: inc.id, actionRefId: draft.id, status: { in: ["PENDING", "APPROVED"] } },
        orderBy: { createdAt: "desc" },
      });
      if (live && live.expiresAt > this.now()) return { approval: live, replayed: true };
      if (live) await tx.approval.update({ where: { id: live.id }, data: { status: "EXPIRED" } });
      if (draft.status !== "DRAFT" && draft.status !== "PENDING_APPROVAL" && draft.status !== "APPROVED")
        throw new AppError("DRAFT_NOT_ACTIONABLE", `Draft is ${draft.status}`, 409);
      const approval = await tx.approval.create({
        data: {
          incidentId: inc.id,
          actionType: input.actionType,
          actionRefId: draft.id,
          actionPayloadHash: actionPayloadHash(payloadOf(draft)),
          requestedBy: p.userId,
          status: "PENDING",
          expiresAt: new Date(this.now().getTime() + APPROVAL_TTL_MS),
        },
      });
      await tx.repairRequest.update({ where: { id: draft.id }, data: { status: "PENDING_APPROVAL" } });
      await this.incidents.event(tx, p, inc.id, "APPROVAL_REQUESTED", {
        approvalId: approval.id,
        repairRequestId: draft.id,
        payloadHash: approval.actionPayloadHash,
        expiresAt: approval.expiresAt,
      });
      if (inc.workflowStatus === "EVIDENCE_REVIEW")
        await this.incidents.transition(tx, p, inc.id, "ACTION_PENDING", "ACTION_PENDING", { approvalId: approval.id });
      return { approval, replayed: false };
    });
  }

  /** Review payload shown to the human: the exact text that will be sent. */
  async getApproval(p: Principal, approvalId: string) {
    const approval = await this.loadApproval(p, approvalId);
    const draft = await this.db.repairRequest.findUnique({ where: { id: approval.actionRefId } });
    return {
      approval,
      action: draft
        ? {
            repairRequestId: draft.id,
            recipientType: draft.recipientType,
            recipientAddress: draft.recipientAddress,
            subject: draft.subject,
            body: draft.body,
            status: draft.status,
          }
        : null,
    };
  }

  private async loadApproval(p: Principal, approvalId: string): Promise<Approval> {
    const a = await this.db.approval.findUnique({ where: { id: approvalId }, include: { incident: { select: { householdId: true } } } });
    if (!a || a.incident.householdId !== p.householdId) throw notFound("approval");
    const { incident: _i, ...approval } = a;
    return approval;
  }

  /** Human decision. Callers must pass a scope:"user" principal; agent credentials are refused. */
  async decide(p: Principal, approvalId: string, decision: "APPROVED" | "REJECTED") {
    if (p.scope !== "user") throw new AppError("HUMAN_APPROVAL_REQUIRED", "Only the signed-in user can approve or reject actions", 403);
    this.requireWriter(p);
    const approval = await this.loadApproval(p, approvalId);
    if (approval.status === decision) return { approval, replayed: true };
    if (approval.status !== "PENDING") throw new AppError(`APPROVAL_${approval.status}`, `Approval is already ${approval.status}`, 409);
    if (approval.expiresAt <= this.now()) {
      await this.db.approval.update({ where: { id: approval.id }, data: { status: "EXPIRED", decidedAt: this.now() } });
      throw new AppError("APPROVAL_EXPIRED", "This approval request expired; ask for a new one", 409);
    }
    const draft = await this.db.repairRequest.findUnique({ where: { id: approval.actionRefId } });
    if (!draft || actionPayloadHash(payloadOf(draft)) !== approval.actionPayloadHash)
      throw new AppError("PAYLOAD_CHANGED", "The draft changed after approval was requested", 409);

    return this.db.$transaction(async (tx) => {
      const res = await tx.approval.updateMany({
        where: { id: approval.id, status: "PENDING" },
        data: { status: decision, approvedBy: decision === "APPROVED" ? p.userId : null, decidedAt: this.now() },
      });
      if (res.count !== 1) throw new AppError("CONCURRENT_MODIFICATION", "Approval was decided concurrently", 409);
      if (decision === "APPROVED") {
        await tx.repairRequest.update({ where: { id: draft.id }, data: { status: "APPROVED" } });
        await this.incidents.event(
          tx,
          p,
          approval.incidentId,
          "APPROVAL_GRANTED",
          { approvalId: approval.id, payloadHash: approval.actionPayloadHash },
          "USER",
        );
      } else {
        await tx.repairRequest.update({ where: { id: draft.id }, data: { status: "CANCELED" } });
        await this.incidents.event(tx, p, approval.incidentId, "APPROVAL_REJECTED", { approvalId: approval.id }, "USER");
        await this.incidents.transition(tx, p, approval.incidentId, "EVIDENCE_REVIEW", "RETURNED_TO_REVIEW", { approvalId: approval.id });
      }
      return { approval: await tx.approval.findUniqueOrThrow({ where: { id: approval.id } }), replayed: false };
    });
  }
}
export type { Prisma };
