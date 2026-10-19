import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { ACTIVE_STATES, assertTransition, assessSafety, IllegalTransitionError, maxRisk, type SafetyAnswers, type WorkflowState } from "@fixloop/domain";
import type { Db } from "../../db.js";
import { AppError, forbidden, notFound } from "../../errors.js";
import type { Principal } from "../../principal.js";

type Tx = Prisma.TransactionClient;

export class IncidentService {
  constructor(private readonly db: Db) {}

  /** Loads an incident and enforces household scope. Cross-household => 404 (no existence leak). */
  private async load(tx: Tx | Db, p: Principal, incidentId: string) {
    const inc = await tx.incident.findUnique({ where: { id: incidentId } });
    if (!inc || inc.householdId !== p.householdId) throw notFound("incident");
    return inc;
  }
  private requireWriter(p: Principal) { if (p.role === "VIEWER") throw forbidden(); }

  private async event(tx: Tx, p: Principal, incidentId: string, eventType: string, payload: object, actorType: "USER" | "SYSTEM" | "AGENT" | "TOOL" | "EXTERNAL" = "TOOL", idempotencyKey?: string) {
    return tx.incidentEvent.create({ data: { incidentId, actorType, actorId: p.userId, eventType, structuredPayload: payload as Prisma.InputJsonValue, correlationId: p.correlationId, idempotencyKey } });
  }

  /** Transition with optimistic concurrency (version check) + event in one transaction. */
  async transition(tx: Tx, p: Principal, incidentId: string, to: WorkflowState, eventType: string, payload: object = {}, extra: Prisma.IncidentUpdateManyMutationInput = {}) {
    const inc = await this.load(tx, p, incidentId);
    if (inc.workflowStatus === to) return inc; // idempotent no-op
    try { assertTransition(inc.workflowStatus, to); } catch (e) {
      if (e instanceof IllegalTransitionError) throw new AppError("ILLEGAL_TRANSITION", e.message, 409);
      throw e;
    }
    const res = await tx.incident.updateMany({
      where: { id: incidentId, version: inc.version },
      data: { workflowStatus: to, version: { increment: 1 }, lastActivityAt: new Date(), ...extra },
    });
    if (res.count !== 1) throw new AppError("CONCURRENT_MODIFICATION", "Incident was modified concurrently; retry", 409);
    await this.event(tx, p, incidentId, eventType, { from: inc.workflowStatus, to, ...payload });
    return this.load(tx, p, incidentId);
  }

  async create(p: Principal, input: { applianceId?: string | undefined; description: string; idempotencyKey: string }) {
    this.requireWriter(p);
    return this.db.$transaction(async (tx) => {
      // Idempotent replay: same key in same household returns the original incident.
      const prior = await tx.incidentEvent.findFirst({
        where: { idempotencyKey: input.idempotencyKey, eventType: "INCIDENT_CREATED", incident: { householdId: p.householdId } },
      });
      if (prior) return { incident: await this.load(tx, p, prior.incidentId), replayed: true };

      if (input.applianceId) {
        const a = await tx.appliance.findUnique({ where: { id: input.applianceId } });
        if (!a || a.householdId !== p.householdId) throw notFound("appliance");
      }
      const title = input.description.length > 80 ? input.description.slice(0, 77) + "..." : input.description;
      const inc = await tx.incident.create({ data: { householdId: p.householdId, applianceId: input.applianceId ?? null, title, description: input.description, createdByUserId: p.userId } });
      await this.event(tx, p, inc.id, "INCIDENT_CREATED", { applianceId: input.applianceId ?? null }, "TOOL", input.idempotencyKey);
      const triaging = await this.transition(tx, p, inc.id, "TRIAGING", "TRIAGE_STARTED");
      return { incident: triaging, replayed: false };
    });
  }

  async get(p: Principal, incidentId: string) {
    const inc = await this.load(this.db, p, incidentId);
    const [events, approvals, appliance] = await Promise.all([
      this.db.incidentEvent.findMany({ where: { incidentId }, orderBy: { timestamp: "desc" }, take: 10 }),
      this.db.approval.findMany({ where: { incidentId, status: "PENDING" } }),
      inc.applianceId ? this.db.appliance.findUnique({ where: { id: inc.applianceId } }) : null,
    ]);
    return { incident: inc, appliance, recentEvents: events.reverse(), pendingApprovals: approvals };
  }

  async listActive(p: Principal, applianceId?: string) {
    return this.db.incident.findMany({
      where: { householdId: p.householdId, workflowStatus: { in: [...ACTIVE_STATES] }, ...(applianceId ? { applianceId } : {}) },
      orderBy: { lastActivityAt: "desc" },
    });
  }

  async timeline(p: Principal, incidentId: string, opts: { limit: number; cursor?: string | undefined }) {
    await this.load(this.db, p, incidentId);
    const rows = await this.db.incidentEvent.findMany({
      where: { incidentId }, orderBy: [{ timestamp: "asc" }, { id: "asc" }], take: opts.limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const nextCursor = rows.length > opts.limit ? rows[opts.limit - 1]!.id : null;
    return { events: rows.slice(0, opts.limit), nextCursor };
  }

  async assessSafety(p: Principal, incidentId: string, answers: SafetyAnswers) {
    this.requireWriter(p);
    return this.db.$transaction(async (tx) => {
      const inc = await this.load(tx, p, incidentId);
      const r = assessSafety(answers);
      // Sticky escalation: never lower a previously recorded risk.
      const risk = inc.severity === "HIGH" || inc.severity === "EMERGENCY" ? maxRisk(inc.severity, r.riskLevel) : r.riskLevel;
      const stickyEscalated = risk === "EMERGENCY" || risk === "HIGH";
      const result = stickyEscalated && !r.escalationRequired
        ? { ...r, riskLevel: risk, safeResponse: "An earlier report on this incident indicated a safety hazard, so conservative guidance still applies. Stay clear of the appliance and contact a licensed professional or your local emergency number. I have not contacted anyone for you." }
        : r;
      await tx.safetyAssessment.create({ data: { incidentId, identifiedHazards: result.hazards, answers: answers as object, riskLevel: result.riskLevel, escalationRequired: stickyEscalated || result.escalationRequired, ruleVersion: result.ruleVersion } });
      await tx.incident.update({ where: { id: incidentId }, data: { severity: risk, safetyStatus: stickyEscalated ? "ESCALATED" : result.riskLevel === "UNKNOWN" ? "NEEDS_ANSWERS" : "CLEARED" } });
      await this.event(tx, p, incidentId, "SAFETY_ASSESSED", { riskLevel: risk, hazards: result.hazards, ruleVersion: result.ruleVersion });
      if (stickyEscalated) await this.transition(tx, p, incidentId, "SAFETY_ESCALATED", "SAFETY_ESCALATED", { hazards: result.hazards });
      else if (result.riskLevel === "LOW") await this.transition(tx, p, incidentId, "READY_FOR_EVIDENCE", "SAFETY_CLEARED");
      const escalationRequired = stickyEscalated || r.escalationRequired;
      return { ...result, riskLevel: risk, escalationRequired, allowedNextActions: escalationRequired ? ["SHOW_EMERGENCY_GUIDANCE", "RECORD_OUTCOME"] : result.allowedNextActions };
    });
  }

  async resolve(p: Principal, incidentId: string, summary: string, idempotencyKey: string) {
    this.requireWriter(p);
    return this.db.$transaction(async (tx) => {
      const inc = await this.load(tx, p, incidentId);
      if (inc.workflowStatus === "RESOLVED") return { incident: inc, replayed: true };
      const out = await this.transition(tx, p, incidentId, "RESOLVED", "INCIDENT_RESOLVED", { summary, idempotencyKey }, { resolvedAt: new Date(), summary });
      return { incident: out, replayed: false };
    });
  }

  async reopen(p: Principal, incidentId: string, reason: string) {
    this.requireWriter(p);
    return this.db.$transaction(async (tx) => {
      const out = await this.transition(tx, p, incidentId, "TRIAGING", "INCIDENT_REOPENED", { reason }, { resolvedAt: null });
      return { incident: out };
    });
  }

  async listAppliances(p: Principal) {
    return this.db.appliance.findMany({ where: { householdId: p.householdId }, orderBy: { createdAt: "asc" } });
  }
}
export const newCorrelationId = () => randomUUID();
