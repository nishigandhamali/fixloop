import { assessSafety } from "@fixloop/domain";
import type { Principal } from "../../principal.js";
import { IntentSchema, SafetyAnswersSchema, type LlmProvider } from "./llm.js";
import { ToolExecutor, type ToolGateway, type ToolTrace, type Phase } from "./tools.js";

export interface SessionState {
  incidentId?: string;
  awaiting?: "SAFETY_ANSWERS";
  description?: string;
}
export type Card =
  | { type: "safety_questions"; questions: string[] }
  | { type: "emergency"; hazards: string[]; guidance: string }
  | {
      type: "evidence";
      overallStatus: string;
      items: { claim: string; status: string; filename: string; page: number; modelMatch: boolean | null; uncertainties: string[] }[];
    }
  | {
      type: "approval";
      approvalId: string;
      status: string;
      subject: string;
      body: string;
      recipientAddress: string | null;
      expiresAt: string | null;
    }
  | {
      type: "status";
      incidentId: string;
      title: string;
      workflowStatus: string;
      severity: string;
      repair: { status: string; reference: string | null; recipientAddress: string | null } | null;
      lastEvents: { eventType: string; timestamp: string }[];
    }
  | { type: "execution"; status: string; providerReference: string | null; message: string; externalCompletionVerified: false }
  | { type: "choice"; incidents: { id: string; title: string }[] };

export interface TurnResult {
  spoken: string;
  cards: Card[];
  uiState: "IDLE" | "AWAITING_CONFIRMATION" | "ERROR";
  state: SessionState;
  incidentId: string | null;
  trace: ToolTrace[];
  phases: Phase[];
  summary: string;
}

const SAFETY_QUESTIONS = [
  "Is any water near an electrical outlet, cord or appliance plug?",
  "Do you smell gas or smoke, or see sparks?",
  "Is water spreading quickly?",
];
const HUMAN: Record<string, string> = {
  CREATED: "just created",
  TRIAGING: "being triaged",
  SAFETY_ESCALATED: "escalated for safety",
  READY_FOR_EVIDENCE: "cleared for next steps",
  EVIDENCE_REVIEW: "in review",
  ACTION_PENDING: "waiting for your approval",
  IN_PROGRESS: "in progress",
  RESOLVED: "resolved",
  CANCELED: "canceled",
};
const NEGATED_HAZARD =
  /\b(no|not|without|never|nothing|isn't|don't|doesn't|haven't)\s+(?:\w+\s+){0,2}?(smoke|smoking|gas|fire|sparks?|sparking|burning|fumes?|outlets?|wires?|wiring|cords?)\b/gi;
const DISCLAIMER = "I'm an informational assistant, not an emergency or repair service.";

export class Coordinator {
  constructor(
    private readonly llm: LlmProvider,
    private readonly gw: ToolGateway,
  ) {}

  async handle(p: Principal, text: string, state: SessionState, msgKey: string): Promise<TurnResult> {
    const tools = new ToolExecutor(this.gw);
    const phases: Phase[] = ["UNDERSTAND"];
    const enter = (ph: Phase) => {
      if (phases[phases.length - 1] !== ph) phases.push(ph);
      return ph;
    };
    const out = (r: Omit<TurnResult, "trace" | "phases" | "summary">, summary?: string): TurnResult => ({
      ...r,
      trace: tools.trace,
      phases,
      summary: summary ?? "",
    });
    let st: SessionState = { ...state };

    // ---- SAFETY GATE: deterministic, runs before the LLM and before any troubleshooting. User text cannot talk its way past it. ----
    // While a safety answer is pending, simple negated phrases ("no gas", "not near the outlet") are not hazard reports.
    // Anything not clearly negated still escalates, and the parsed answers go through the same safety engine afterwards.
    const scanText = st.awaiting === "SAFETY_ANSWERS" ? text.replace(NEGATED_HAZARD, " ") : text;
    const hazard = assessSafety({ freeText: scanText });
    if (hazard.riskLevel === "EMERGENCY" || hazard.riskLevel === "HIGH") {
      enter("SAFETY_CHECK");
      if (!st.incidentId) {
        const r = await tools.call("SAFETY_CHECK", "create_incident", {
          householdId: p.householdId,
          description: text.slice(0, 1000),
          idempotencyKey: `conv-${msgKey}`,
        });
        if (r.ok) st = { ...st, incidentId: r.data.incidentId as string, description: text };
      }
      let guidance = hazard.safeResponse,
        hazards = hazard.hazards as string[];
      if (st.incidentId) {
        const a = await tools.call("SAFETY_CHECK", "assess_incident_safety", {
          incidentId: st.incidentId,
          answers: { freeText: text.slice(0, 2000) },
        });
        if (a.ok) {
          guidance = a.data.safeResponse;
          hazards = a.data.hazards;
        }
      }
      delete st.awaiting;
      return out(
        {
          spoken: guidance,
          cards: [{ type: "emergency", hazards, guidance }],
          uiState: "IDLE",
          state: st,
          incidentId: st.incidentId ?? null,
        },
        "Safety escalation",
      );
    }

    const intent = await this.llm.generateStructured({ task: "classify_intent", schema: IntentSchema, input: { text } });
    const hint = intent.applianceHint;

    // ---- answering the pending safety question ----
    if (st.awaiting === "SAFETY_ANSWERS" && st.incidentId && (intent.intent === "OTHER" || intent.intent === "REPORT_PROBLEM")) {
      const parsed = await this.llm.generateStructured({ task: "parse_safety_answers", schema: SafetyAnswersSchema, input: { text } });
      if (!parsed.understood)
        return out({
          spoken: "I need a clear answer to stay safe. " + SAFETY_QUESTIONS.join(" "),
          cards: [{ type: "safety_questions", questions: SAFETY_QUESTIONS }],
          uiState: "IDLE",
          state: st,
          incidentId: st.incidentId,
        });
      enter("SAFETY_CHECK");
      const { understood: _u, ...answers } = parsed;
      const a = await tools.call("SAFETY_CHECK", "assess_incident_safety", {
        incidentId: st.incidentId,
        answers: { nearElectricalOutlet: false, smokeOrBurningSmell: false, gasSmell: false, waterSpreadingQuickly: false, ...answers },
      });
      if (!a.ok) return this.fail(out, st);
      if (a.data.escalationRequired) {
        delete st.awaiting;
        return out(
          {
            spoken: a.data.safeResponse,
            cards: [{ type: "emergency", hazards: a.data.hazards, guidance: a.data.safeResponse }],
            uiState: "IDLE",
            state: st,
            incidentId: st.incidentId,
          },
          "Safety escalation",
        );
      }
      delete st.awaiting;
      return this.propose(p, st, tools, enter, out);
    }

    switch (intent.intent) {
      case "REPORT_PROBLEM":
        return this.report(p, text, hint, st, tools, enter, out, msgKey);
      case "STATUS_QUERY":
        return this.status(p, hint, st, tools, enter, out);
      case "SEND_REQUEST":
        return this.send(p, hint, st, tools, enter, out);
      case "RESOLVE":
        return this.resolve(p, text, hint, st, tools, enter, out);
      case "APPROVAL_QUESTION":
        return this.approvalHelp(p, hint, st, tools, enter, out);
      default:
        return out({
          spoken: "I can help with a household problem, check on an existing case, or send an approved repair request. What's going on?",
          cards: [],
          uiState: "IDLE",
          state: st,
          incidentId: st.incidentId ?? null,
        });
    }
  }

  private fail(out: (r: any, s?: string) => TurnResult, st: SessionState) {
    return out({
      spoken: "Something went wrong talking to the case system. Nothing was changed that I can confirm. Please try again.",
      cards: [],
      uiState: "ERROR",
      state: st,
      incidentId: st.incidentId ?? null,
    });
  }

  private async report(
    p: Principal,
    text: string,
    hint: string | null,
    st: SessionState,
    tools: ToolExecutor,
    enter: (p: Phase) => Phase,
    out: any,
    msgKey: string,
  ): Promise<TurnResult> {
    enter("DISCOVER_CONTEXT");
    const appl = await tools.call("DISCOVER_CONTEXT", "list_household_appliances", { householdId: p.householdId });
    const list: any[] = appl.data.appliances ?? [];
    const lower = text.toLowerCase();
    const match = list.find(
      (a) =>
        (hint && (a.category.toLowerCase().includes(hint) || hint.includes(a.category.toLowerCase()))) ||
        lower.includes(a.modelNumber.toLowerCase()) ||
        lower.includes(a.brand.toLowerCase()),
    );
    if (match) {
      const active = await tools.call("DISCOVER_CONTEXT", "list_active_incidents", { householdId: p.householdId, applianceId: match.id });
      const existing = (active.data.incidents ?? [])[0];
      if (existing) {
        st = { ...st, incidentId: existing.id };
        return out(
          {
            spoken: `You already have an open ${match.category.toLowerCase()} case, so I won't start a duplicate. Ask me for the status, or say "send it" if a request is approved.`,
            cards: [{ type: "choice", incidents: [{ id: existing.id, title: existing.title }] }],
            uiState: "IDLE",
            state: st,
            incidentId: existing.id,
          },
          "Resumed existing case",
        );
      }
    }
    enter("SAFETY_CHECK");
    const c = await tools.call("SAFETY_CHECK", "create_incident", {
      householdId: p.householdId,
      applianceId: match?.id,
      description: text.slice(0, 1000),
      idempotencyKey: `conv-${msgKey}`,
    });
    if (!c.ok) return this.fail(out, st);
    st = { incidentId: c.data.incidentId, awaiting: "SAFETY_ANSWERS", description: text };
    const which = match ? `your ${match.brand} ${match.category.toLowerCase()}` : "that";
    return out(
      {
        spoken: `I've opened a case for ${which}. First, safety: ${SAFETY_QUESTIONS.join(" ")}`,
        cards: [{ type: "safety_questions", questions: SAFETY_QUESTIONS }],
        uiState: "IDLE",
        state: st,
        incidentId: st.incidentId ?? null,
      },
      `Opened incident`,
    );
  }

  private async propose(p: Principal, st: SessionState, tools: ToolExecutor, enter: (p: Phase) => Phase, out: any): Promise<TurnResult> {
    const incidentId = st.incidentId!;
    enter("GATHER_EVIDENCE");
    const ev = await tools.call("GATHER_EVIDENCE", "find_document_evidence", {
      incidentId,
      question: (st.description ?? "leaking").slice(0, 400),
    });
    const cards: Card[] = [];
    if (ev.ok)
      cards.push({
        type: "evidence",
        overallStatus: ev.data.overallStatus,
        items: (ev.data.evidence as any[]).map((e) => ({
          claim: e.claim,
          status: e.verificationStatus,
          filename: e.sources[0].filename,
          page: e.sources[0].pageNumber,
          modelMatch: e.sources[0].modelMatch,
          uncertainties: e.uncertainties,
        })),
      });
    enter("PROPOSE_ACTION");
    const d = await tools.call("PROPOSE_ACTION", "draft_repair_request", { incidentId, recipientType: "REPAIR_TECHNICIAN" });
    if (!d.ok)
      return out({
        spoken: `No immediate hazard was reported, but I couldn't prepare a repair request (${d.errorCode}).`,
        cards,
        uiState: "ERROR",
        state: st,
        incidentId,
      });
    const ap = await tools.call("PROPOSE_ACTION", "request_action_approval", {
      incidentId,
      actionType: "SUBMIT_REPAIR_REQUEST",
      draftId: d.data.draftId,
    });
    if (!ap.ok) return this.fail(out, st);
    enter("AWAIT_APPROVAL");
    cards.push({
      type: "approval",
      approvalId: ap.data.approvalId,
      status: "PENDING",
      subject: d.data.subject,
      body: d.data.body,
      recipientAddress: d.data.recipientAddress,
      expiresAt: ap.data.expiresAt,
    });
    const verified = ev.ok && ev.data.overallStatus === "VERIFIED";
    return out(
      {
        spoken: `Thanks. No immediate hazard reported. ${verified ? "I found matching guidance in your manual. " : "I couldn't verify manual guidance for this. "}The repair request is ready for your approval. Nothing has been sent.`,
        cards,
        uiState: "AWAITING_CONFIRMATION",
        state: st,
        incidentId,
      },
      "Draft ready for approval",
    );
  }

  /** Resolves which incident the user means from durable state, asking if ambiguous. */
  private async pick(
    p: Principal,
    hint: string | null,
    st: SessionState,
    tools: ToolExecutor,
    enter: (p: Phase) => Phase,
  ): Promise<{ id?: string; ask?: any[]; none?: boolean }> {
    enter("DISCOVER_CONTEXT");
    if (st.incidentId && !hint) return { id: st.incidentId };
    let applianceId: string | undefined;
    if (hint) {
      const al = await tools.call("DISCOVER_CONTEXT", "list_household_appliances", { householdId: p.householdId });
      applianceId = (al.data.appliances ?? []).find(
        (a: any) => a.category.toLowerCase().includes(hint) || hint.includes(a.category.toLowerCase()),
      )?.id;
    }
    const r = await tools.call("DISCOVER_CONTEXT", "list_active_incidents", {
      householdId: p.householdId,
      ...(applianceId ? { applianceId } : {}),
    });
    const list: any[] = r.data.incidents ?? [];
    if (list.length === 0) return { none: true };
    if (list.length === 1) return { id: list[0].id };
    return { ask: list.map((i) => ({ id: i.id, title: i.title })) };
  }

  private async load(tools: ToolExecutor, phase: Phase, id: string) {
    return tools.call(phase, "get_incident", { incidentId: id });
  }

  private statusCard(d: any): Card {
    const rr = (d.repairRequests as any[]).at(-1) ?? null;
    return {
      type: "status",
      incidentId: d.incident.id,
      title: d.incident.title,
      workflowStatus: d.incident.workflowStatus,
      severity: d.incident.severity,
      repair: rr ? { status: rr.status, reference: rr.externalReference, recipientAddress: rr.recipientAddress } : null,
      lastEvents: (d.recentEvents as any[]).slice(-5).map((e) => ({ eventType: e.eventType, timestamp: e.timestamp })),
    };
  }

  private async status(
    p: Principal,
    hint: string | null,
    st: SessionState,
    tools: ToolExecutor,
    enter: (p: Phase) => Phase,
    out: any,
  ): Promise<TurnResult> {
    const sel = await this.pick(p, hint, st, tools, enter);
    if (sel.none)
      return out({ spoken: "I don't see any open cases for your household.", cards: [], uiState: "IDLE", state: st, incidentId: null });
    if (sel.ask)
      return out({
        spoken: `You have ${sel.ask.length} open cases. Which one do you mean?`,
        cards: [{ type: "choice", incidents: sel.ask }],
        uiState: "IDLE",
        state: st,
        incidentId: null,
      });
    enter("SUMMARIZE");
    const g = await this.load(tools, "SUMMARIZE", sel.id!);
    if (!g.ok) return this.fail(out, st);
    st = { ...st, incidentId: sel.id! };
    const d = g.data as any;
    const rr = (d.repairRequests as any[]).at(-1);
    const types = (d.recentEvents as any[]).map((e) => e.eventType);
    const unknown = types.includes("REPAIR_SUBMISSION_UNKNOWN_OUTCOME") && rr?.status !== "SENT";
    let repair = "No repair request has been drafted.";
    if (rr)
      repair =
        (
          {
            DRAFT: "A repair request is drafted but not sent.",
            PENDING_APPROVAL: "A repair request is waiting for your approval. Nothing has been sent.",
            APPROVED: unknown
              ? 'You approved it, but the last submission attempt has an unconfirmed outcome. Say "send it" and I\'ll check before doing anything.'
              : 'You approved it, but it hasn\'t been submitted yet. Say "send it".',
            SENT: rr.recipientAddress
              ? `The request was emailed to ${rr.recipientAddress} (reference ${rr.externalReference}). They haven't confirmed, so completion is not verified.`
              : `The request was submitted to the simulated provider (reference ${rr.externalReference}). External completion is not verified.`,
            FAILED: "The provider rejected the request.",
            CANCELED: "The last draft was canceled.",
          } as Record<string, string>
        )[rr.status] ?? "";
    const spoken = `Your ${d.appliance ? d.appliance.category.toLowerCase() : "household"} case is ${HUMAN[d.incident.workflowStatus] ?? d.incident.workflowStatus}. ${repair}`;
    const cards: Card[] = [this.statusCard(d)];
    const pending = (d.pendingApprovals as any[]).find((a) => a.status === "PENDING");
    if (pending && rr)
      cards.push({
        type: "approval",
        approvalId: pending.id,
        status: pending.status,
        subject: rr.subject,
        body: rr.body,
        recipientAddress: rr.recipientAddress,
        expiresAt: pending.expiresAt,
      });
    return out(
      { spoken, cards, uiState: pending ? "AWAITING_CONFIRMATION" : "IDLE", state: st, incidentId: sel.id },
      "Status from durable case",
    );
  }

  private async send(
    p: Principal,
    hint: string | null,
    st: SessionState,
    tools: ToolExecutor,
    enter: (p: Phase) => Phase,
    out: any,
  ): Promise<TurnResult> {
    const sel = await this.pick(p, hint, st, tools, enter);
    if (!sel.id)
      return out({
        spoken: sel.none ? "There's no open case to send a request for." : "Which case do you mean?",
        cards: sel.ask ? [{ type: "choice", incidents: sel.ask }] : [],
        uiState: "IDLE",
        state: st,
        incidentId: null,
      });
    const g = await this.load(tools, "DISCOVER_CONTEXT", sel.id);
    if (!g.ok) return this.fail(out, st);
    const d = g.data as any;
    const approved = (d.pendingApprovals as any[]).find((a) => a.status === "APPROVED");
    const pending = (d.pendingApprovals as any[]).find((a) => a.status === "PENDING");
    st = { ...st, incidentId: sel.id };
    if (!approved) {
      const rr = (d.repairRequests as any[]).at(-1);
      if (pending && rr)
        return out({
          spoken:
            "I can't send anything until you approve it. Please review the request and tap Approve. I'm not able to approve on your behalf.",
          cards: [
            {
              type: "approval",
              approvalId: pending.id,
              status: "PENDING",
              subject: rr.subject,
              body: rr.body,
              recipientAddress: rr.recipientAddress,
              expiresAt: pending.expiresAt,
            },
          ],
          uiState: "AWAITING_CONFIRMATION",
          state: st,
          incidentId: sel.id,
        });
      return out({
        spoken: "There's no approved request waiting to be sent.",
        cards: [this.statusCard(d)],
        uiState: "IDLE",
        state: st,
        incidentId: sel.id,
      });
    }
    enter("EXECUTE");
    const e = await tools.call("EXECUTE", "execute_approved_action", {
      incidentId: sel.id,
      approvalId: approved.id,
      idempotencyKey: `agent-exec-${approved.id}`,
    });
    if (!e.ok)
      return out({
        spoken: `I couldn't send it (${e.errorCode}). Nothing was sent.`,
        cards: [],
        uiState: "ERROR",
        state: st,
        incidentId: sel.id,
      });
    const spoken =
      {
        SUCCEEDED: e.data.recipientAddress
          ? `Done. I emailed the request to ${e.data.recipientAddress}, reference ${e.data.providerReference}. They haven't confirmed, and I can't confirm completion.`
          : `Done. The request was submitted to the simulated provider, reference ${e.data.providerReference}. No real technician was contacted, and I can't confirm completion.`,
        UNKNOWN_OUTCOME:
          "I couldn't confirm whether the request went through. I won't resend blindly; say \"send it\" again and I'll check first.",
        FAILED_RETRYABLE: "I couldn't confirm it after several tries. It's safe to try again; a retry can't send it twice.",
        FAILED_PERMANENT: "The provider rejected the request. Nothing was sent.",
      }[e.data.status as string] ?? e.data.message;
    return out(
      {
        spoken,
        cards: [
          {
            type: "execution",
            status: e.data.status,
            providerReference: e.data.providerReference,
            message: e.data.message,
            externalCompletionVerified: false,
          },
        ],
        uiState: "IDLE",
        state: st,
        incidentId: sel.id,
      },
      `Execution ${e.data.status}`,
    );
  }

  private async resolve(
    p: Principal,
    text: string,
    hint: string | null,
    st: SessionState,
    tools: ToolExecutor,
    enter: (p: Phase) => Phase,
    out: any,
  ): Promise<TurnResult> {
    const sel = await this.pick(p, hint, st, tools, enter);
    if (!sel.id)
      return out({
        spoken: sel.none ? "There's no open case to resolve." : "Which case should I mark resolved?",
        cards: sel.ask ? [{ type: "choice", incidents: sel.ask }] : [],
        uiState: "IDLE",
        state: st,
        incidentId: null,
      });
    // Resolving is a human decision (REST, user scope); the agent has no resolve tool, so it points to the explicit button.
    enter("SUMMARIZE");
    const d = await this.load(tools, "SUMMARIZE", sel.id);
    st = { ...st, incidentId: sel.id };
    delete st.awaiting;
    return out({
      spoken: "Glad it's sorted. To close this case, open it and press Mark resolved. I can't close cases myself.",
      cards: d.ok ? [this.statusCard(d.data)] : [],
      uiState: "IDLE",
      state: st,
      incidentId: sel.id,
    });
  }

  private async approvalHelp(
    p: Principal,
    hint: string | null,
    st: SessionState,
    tools: ToolExecutor,
    enter: (p: Phase) => Phase,
    out: any,
  ): Promise<TurnResult> {
    const sel = await this.pick(p, hint, st, tools, enter);
    if (sel.id) {
      const g = await this.load(tools, "DISCOVER_CONTEXT", sel.id);
      const d = g.data as any;
      const pending = (d.pendingApprovals ?? []).find((a: any) => a.status === "PENDING");
      const rr = (d.repairRequests ?? []).at(-1);
      if (pending && rr)
        return out({
          spoken: "Approvals are done by you, on screen. Please review the request and tap Approve or Reject.",
          cards: [
            {
              type: "approval",
              approvalId: pending.id,
              status: "PENDING",
              subject: rr.subject,
              body: rr.body,
              recipientAddress: rr.recipientAddress,
              expiresAt: pending.expiresAt,
            },
          ],
          uiState: "AWAITING_CONFIRMATION",
          state: { ...st, incidentId: sel.id },
          incidentId: sel.id,
        });
    }
    return out({
      spoken: "There's nothing waiting for your approval. " + DISCLAIMER,
      cards: [],
      uiState: "IDLE",
      state: st,
      incidentId: st.incidentId ?? null,
    });
  }
}
