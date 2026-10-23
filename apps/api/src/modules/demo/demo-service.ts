import type { Db } from "../../db.js";
import type { BlobStorage } from "../../adapters/storage.js";
import type { SimulatedRepairProvider } from "../../adapters/provider.js";
import { FIXTURES, ingestFixture, seedDocuments } from "../../seed-documents.js";
import type { Principal } from "../../principal.js";
import type { IncidentService } from "../incidents/incident-service.js";
import type { RepairService } from "../repair/repair-service.js";
import type { ExecutionService } from "../repair/execution-service.js";
import { seed, SEED_IDS } from "../../../../../prisma/seed.js";

export const SCENARIOS = ["dishwasher_leak", "resume_incident", "wrong_model", "emergency", "interrupted_submission"] as const;
export type Scenario = (typeof SCENARIOS)[number];

const META: Record<Scenario, { title: string; utterance: string; description: string }> = {
  dishwasher_leak: {
    title: "Dishwasher leak",
    utterance: "My dishwasher is leaking and I don't know what to do",
    description: "Clean slate with the correct manual and warranty on file.",
  },
  resume_incident: {
    title: "Resume dishwasher incident",
    utterance: "What happened with my dishwasher?",
    description: "A dishwasher case already submitted to the simulated provider, in a fresh conversation.",
  },
  wrong_model: {
    title: "Wrong-model document",
    utterance: "My dishwasher is leaking and I don't know what to do",
    description: "Only a manual for a DIFFERENT model (AQ-DW900) is on file; its claims cannot be verified.",
  },
  emergency: {
    title: "Emergency escalation",
    utterance: "There is water leaking near the outlet behind my dishwasher",
    description: "Clean slate; speak a hazard phrase to see conservative guidance.",
  },
  interrupted_submission: {
    title: "Interrupted submission",
    utterance: "Send it",
    description:
      "An approved request; the first send times out after reaching the provider and status lookup fails, so the outcome is unknown until you retry.",
  },
};

/** Demo-only fixtures. Everything is created through the real domain services, never faked in the UI. */
export class DemoService {
  constructor(
    private readonly db: Db,
    private readonly storage: BlobStorage,
    private readonly incidents: IncidentService,
    private readonly repair: RepairService,
    private readonly exec: ExecutionService,
    private readonly provider: SimulatedRepairProvider,
  ) {}

  private async wipe(p: Principal, withDocs: boolean) {
    await this.db.$executeRawUnsafe(
      `TRUNCATE "ConversationMessage","ConversationSession","IncidentEvent","SafetyAssessment","EvidenceReference","RepairRequest","Approval","Incident","ToolExecution","OutboxEvent","ProviderRequest" RESTART IDENTITY CASCADE`,
    );
    if (withDocs) await this.db.$executeRawUnsafe(`TRUNCATE "DocumentChunk","ApplianceDocument" RESTART IDENTITY CASCADE`);
    // user-added appliances go too (their documents/cases were just removed, so the FK restriction is satisfied)
    if (withDocs) await this.db.appliance.deleteMany({ where: { householdId: p.householdId, id: { not: SEED_IDS.appliance } } });
    this.provider.clearFaults();
    await seed(this.db);
    return p;
  }
  async reset(p: Principal, applianceId: string) {
    await this.wipe(p, true);
    await seedDocuments(this.db, this.storage, p, applianceId);
    return { reset: true };
  }

  private async approvedDraft(p: Principal, agent: Principal, applianceId: string) {
    const inc = (
      await this.incidents.create(agent, {
        applianceId,
        description: "My dishwasher is leaking from the door",
        idempotencyKey: `demo-${Date.now()}`,
      })
    ).incident;
    await this.incidents.assessSafety(agent, inc.id, {
      nearElectricalOutlet: false,
      smokeOrBurningSmell: false,
      gasSmell: false,
      waterSpreadingQuickly: false,
    });
    const { draft } = await this.repair.draft(agent, { incidentId: inc.id, recipientType: "REPAIR_TECHNICIAN" });
    const { approval } = await this.repair.requestApproval(agent, {
      incidentId: inc.id,
      actionType: "SUBMIT_REPAIR_REQUEST",
      draftId: draft.id,
    });
    await this.repair.decide(p, approval.id, "APPROVED");
    return { incidentId: inc.id, approvalId: approval.id };
  }

  async launch(p: Principal, scenario: Scenario, applianceId: string) {
    await this.reset(p, applianceId);
    const agent: Principal = { ...p, scope: "agent" };
    let incidentId: string | null = null;
    if (scenario === "wrong_model") {
      await this.db.$executeRawUnsafe(`TRUNCATE "DocumentChunk","ApplianceDocument" RESTART IDENTITY CASCADE`);
      await ingestFixture(this.db, this.storage, p, applianceId, FIXTURES.wrongModel);
    }
    if (scenario === "resume_incident") {
      const a = await this.approvedDraft(p, agent, applianceId);
      await this.exec.execute(agent, { incidentId: a.incidentId, approvalId: a.approvalId, idempotencyKey: `demo-exec-${a.approvalId}` });
      incidentId = a.incidentId;
    }
    if (scenario === "interrupted_submission") {
      const a = await this.approvedDraft(p, agent, applianceId);
      this.provider.script("submit:timeout_after", "lookup:fail");
      incidentId = a.incidentId;
    }
    return { scenario, incidentId, ...META[scenario] };
  }
}
