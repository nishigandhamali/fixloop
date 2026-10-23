export interface Incident {
  id: string;
  title: string;
  description: string;
  workflowStatus: string;
  severity: string;
  safetyStatus: string;
  applianceId: string | null;
  lastActivityAt: string;
  openedAt: string;
  resolvedAt: string | null;
  summary: string | null;
}
export interface Appliance {
  id: string;
  category: string;
  brand: string;
  modelNumber: string;
  serialNumber: string | null;
  location: string | null;
  notes: string | null;
}
export interface IncidentEvent {
  id: string;
  eventType: string;
  actorType: string;
  timestamp: string;
  structuredPayload: Record<string, unknown>;
}
export interface RepairRequest {
  id: string;
  status: string;
  subject: string;
  body: string;
  recipientType: string;
  externalReference: string | null;
  sentAt: string | null;
}
export interface Approval {
  id: string;
  status: string;
  expiresAt: string;
  actionRefId: string;
}
export interface IncidentDetail {
  incident: Incident;
  appliance: Appliance | null;
  recentEvents: IncidentEvent[];
  pendingApprovals: Approval[];
  repairRequests: RepairRequest[];
  latestSafety: {
    riskLevel: string;
    identifiedHazards: string[];
    escalationRequired: boolean;
    ruleVersion: string;
    completedAt: string;
  } | null;
}
export interface DocumentMeta {
  id: string;
  type: string;
  originalFilename: string;
  declaredModels: string[];
  expiresOn: string | null;
  processingStatus: string;
  applianceId: string | null;
}
export type Card =
  | { type: "safety_questions"; questions: string[] }
  | { type: "emergency"; hazards: string[]; guidance: string }
  | {
      type: "evidence";
      overallStatus: string;
      items: { claim: string; status: string; filename: string; page: number; modelMatch: boolean | null; uncertainties: string[] }[];
    }
  | { type: "approval"; approvalId: string; status: string; subject: string; body: string; expiresAt: string | null }
  | {
      type: "status";
      incidentId: string;
      title: string;
      workflowStatus: string;
      severity: string;
      repair: { status: string; reference: string | null } | null;
      lastEvents: { eventType: string; timestamp: string }[];
    }
  | { type: "execution"; status: string; providerReference: string | null; message: string; externalCompletionVerified: false }
  | { type: "choice"; incidents: { id: string; title: string }[] };
