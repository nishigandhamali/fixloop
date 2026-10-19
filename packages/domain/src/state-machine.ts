export const WORKFLOW_STATES = [
  "CREATED", "TRIAGING", "SAFETY_ESCALATED", "READY_FOR_EVIDENCE", "EVIDENCE_REVIEW",
  "ACTION_PENDING", "IN_PROGRESS", "RESOLVED", "CANCELED",
] as const;
export type WorkflowState = (typeof WORKFLOW_STATES)[number];

/** Explicit transition matrix. Anything not listed is illegal. */
const TRANSITIONS: Record<WorkflowState, readonly WorkflowState[]> = {
  CREATED: ["TRIAGING", "CANCELED"],
  TRIAGING: ["SAFETY_ESCALATED", "READY_FOR_EVIDENCE", "CANCELED"],
  SAFETY_ESCALATED: ["READY_FOR_EVIDENCE", "RESOLVED", "CANCELED"],
  READY_FOR_EVIDENCE: ["EVIDENCE_REVIEW", "SAFETY_ESCALATED", "CANCELED"],
  EVIDENCE_REVIEW: ["ACTION_PENDING", "SAFETY_ESCALATED", "CANCELED"],
  ACTION_PENDING: ["IN_PROGRESS", "EVIDENCE_REVIEW", "CANCELED"],
  IN_PROGRESS: ["RESOLVED", "ACTION_PENDING", "CANCELED"],
  RESOLVED: ["TRIAGING"], // reopen only
  CANCELED: [],
};

export class IllegalTransitionError extends Error {
  readonly code = "ILLEGAL_TRANSITION";
  constructor(readonly from: WorkflowState, readonly to: WorkflowState) {
    super(`Illegal transition ${from} -> ${to}`);
  }
}

export function canTransition(from: WorkflowState, to: WorkflowState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: WorkflowState, to: WorkflowState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

export function allowedTransitions(from: WorkflowState): readonly WorkflowState[] {
  return TRANSITIONS[from];
}

export const ACTIVE_STATES: readonly WorkflowState[] = WORKFLOW_STATES.filter(
  (s) => s !== "RESOLVED" && s !== "CANCELED",
);
