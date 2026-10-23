import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { FIXTURES, ingestFixture } from "../src/seed-documents.js";
import { mcpClient, SEED_IDS, startApp, tokenFor } from "./helpers.js";

type Ctx = Awaited<ReturnType<typeof startApp>>;
let ctx: Ctx;
const opened: Ctx[] = [];
const agent = () => tokenFor(SEED_IDS.user, SEED_IDS.household, "agent");
const human = () => tokenFor(SEED_IDS.user, SEED_IDS.household, "user");
const otherHuman = () => tokenFor(SEED_IDS.otherUser, SEED_IDS.otherHousehold, "user");
const otherAgent = () => tokenFor(SEED_IDS.otherUser, SEED_IDS.otherHousehold, "agent");
const sc = (r: unknown) => (r as { structuredContent: Record<string, any> }).structuredContent;
const owner = () => ({ userId: SEED_IDS.user, householdId: SEED_IDS.household, role: "OWNER" as const, correlationId: "t" });
const providerCount = () => ctx.db.providerRequest.count();

beforeEach(async () => {
  ctx = await startApp();
  opened.push(ctx);
  await ingestFixture(ctx.db, ctx.storage, owner(), SEED_IDS.appliance, FIXTURES.manual);
});
afterAll(async () => {
  for (const c of opened) await c.close().catch(() => undefined);
});

type Client = Awaited<ReturnType<typeof mcpClient>>["client"];
const call = (c: Client, name: string, args: Record<string, unknown>) => c.callTool({ name, arguments: args });
const rest = (path: string, token: string, method = "GET", body?: unknown) =>
  fetch(`${ctx.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });

async function clearedIncident(client: Client, description = "My dishwasher is leaking from the door") {
  const { incidentId } = sc(
    await call(client, "create_incident", {
      householdId: SEED_IDS.household,
      applianceId: SEED_IDS.appliance,
      description,
      idempotencyKey: `inc-${Math.random().toString(36).slice(2, 12)}`,
    }),
  );
  await call(client, "assess_incident_safety", {
    incidentId,
    answers: { nearElectricalOutlet: false, smokeOrBurningSmell: false, gasSmell: false, waterSpreadingQuickly: false },
  });
  return incidentId as string;
}
async function pendingApproval(client: Client) {
  const incidentId = await clearedIncident(client);
  const draft = sc(await call(client, "draft_repair_request", { incidentId, recipientType: "REPAIR_TECHNICIAN" }));
  const appr = sc(
    await call(client, "request_action_approval", { incidentId, actionType: "SUBMIT_REPAIR_REQUEST", draftId: draft.draftId }),
  );
  return { incidentId, draft, approvalId: appr.approvalId as string, appr };
}
async function approvedApproval(client: Client) {
  const x = await pendingApproval(client);
  const res = await rest(`/api/v1/approvals/${x.approvalId}/approve`, human(), "POST");
  expect(res.status).toBe(200);
  return x;
}
const exec = (c: Client, incidentId: string, approvalId: string, idempotencyKey = "exec-key-0001") =>
  call(c, "execute_approved_action", { incidentId, approvalId, idempotencyKey });

describe("approval-gated golden path", () => {
  it("draft -> approval -> human approve -> execute -> exactly one provider request, with a faithful timeline", async () => {
    const { client } = await mcpClient(ctx.url, agent());
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["draft_repair_request", "request_action_approval", "execute_approved_action"]));
    expect(tools.filter((n) => /(^|_)(approve|reject|decide|grant)(_|$)/.test(n))).toEqual([]); // the model has no approve tool

    const incidentId = await clearedIncident(client);
    const draft = sc(
      await call(client, "draft_repair_request", { incidentId, recipientType: "REPAIR_TECHNICIAN", messageContext: "Prefer mornings" }),
    );
    expect(draft.status).toBe("DRAFT");
    expect(draft.sent).toBe(false);
    expect(draft.body).toMatch(/Aquavelle AQ-DW450/);
    expect(draft.body).toMatch(/page 2/);
    expect(draft.body).toMatch(/Prefer mornings/);
    expect(draft.body).not.toMatch(/SYNTH-0001/); // serial number is not disclosed
    expect(draft.body).not.toMatch(/ignore previous/i);
    expect(await providerCount()).toBe(0);
    expect(sc(await call(client, "get_incident", { incidentId })).incident.workflowStatus).toBe("EVIDENCE_REVIEW");

    const appr = sc(
      await call(client, "request_action_approval", { incidentId, actionType: "SUBMIT_REPAIR_REQUEST", draftId: draft.draftId }),
    );
    expect(appr.status).toBe("PENDING");
    expect(appr.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(sc(await call(client, "get_incident", { incidentId })).incident.workflowStatus).toBe("ACTION_PENDING");

    // not yet approved => refused, nothing sent
    const early = await exec(client, incidentId, appr.approvalId);
    expect(early.isError).toBe(true);
    expect(sc(early).error.code).toBe("APPROVAL_REQUIRED");
    // the agent credential cannot approve
    const agentApprove = await rest(`/api/v1/approvals/${appr.approvalId}/approve`, agent(), "POST");
    expect(agentApprove.status).toBe(401);
    expect(await providerCount()).toBe(0);

    // human reviews the exact text, then approves
    const review = (await (await rest(`/api/v1/approvals/${appr.approvalId}`, human())).json()) as any;
    expect(review.action.body).toBe(draft.body);
    expect((await rest(`/api/v1/approvals/${appr.approvalId}/approve`, human(), "POST")).status).toBe(200);

    const done = sc(await exec(client, incidentId, appr.approvalId));
    expect(done.status).toBe("SUCCEEDED");
    expect(done.providerReference).toMatch(/^SIM-[A-F0-9]{10}$/);
    expect(done.externalCompletionVerified).toBe(false);
    expect(done.message).toMatch(/NOT been contacted/);
    expect(await providerCount()).toBe(1);

    const inc = sc(await call(client, "get_incident", { incidentId }));
    expect(inc.incident.workflowStatus).toBe("IN_PROGRESS");
    expect(inc.repairRequests[0].status).toBe("SENT");
    expect(inc.repairRequests[0].externalReference).toBe(done.providerReference);
    const approval = await ctx.db.approval.findUniqueOrThrow({ where: { id: appr.approvalId } });
    expect(approval.status).toBe("CONSUMED");
    expect(approval.approvedBy).toBe(SEED_IDS.user);
    expect(approval.consumedAt).not.toBeNull();

    const tl = sc(await call(client, "get_incident_timeline", { incidentId, limit: 50 })).events.map((e: any) => e.eventType);
    expect(tl).toEqual(
      [
        "INCIDENT_CREATED",
        "TRIAGE_STARTED",
        "SAFETY_ASSESSED",
        "SAFETY_CLEARED",
        "REPAIR_DRAFTED",
        "EVIDENCE_REVIEWED",
        "APPROVAL_REQUESTED",
        "ACTION_PENDING",
        "APPROVAL_GRANTED",
        "REPAIR_REQUEST_SUBMITTED",
        "IN_PROGRESS",
      ].sort((a, b) => tl.indexOf(a) - tl.indexOf(b)),
    );
    for (const t of ["APPROVAL_GRANTED", "REPAIR_REQUEST_SUBMITTED"]) expect(tl.filter((x: string) => x === t)).toHaveLength(1);
    expect(tl.indexOf("APPROVAL_GRANTED")).toBeLessThan(tl.indexOf("REPAIR_REQUEST_SUBMITTED"));
    // the incident can then be resolved by the human
    const res = await rest(`/api/v1/incidents/${incidentId}/resolve`, human(), "POST", {
      resolutionSummary: "Replaced gasket",
      idempotencyKey: "resolve-0001",
    });
    expect(res.status).toBe(200);
  });

  it("drafting is idempotent and refuses unsafe or unassessed incidents", async () => {
    const { client } = await mcpClient(ctx.url, agent());
    const id = await clearedIncident(client);
    const a = sc(await call(client, "draft_repair_request", { incidentId: id, recipientType: "REPAIR_TECHNICIAN" }));
    const b = sc(await call(client, "draft_repair_request", { incidentId: id, recipientType: "REPAIR_TECHNICIAN" }));
    expect(b.draftId).toBe(a.draftId);
    expect(b.replayed).toBe(true);
    expect(await ctx.db.repairRequest.count()).toBe(1);

    const fresh = sc(
      await call(client, "create_incident", {
        householdId: SEED_IDS.household,
        applianceId: SEED_IDS.appliance,
        description: "unassessed incident",
        idempotencyKey: "inc-unassessed-1",
      }),
    ).incidentId;
    expect(sc(await call(client, "draft_repair_request", { incidentId: fresh, recipientType: "REPAIR_TECHNICIAN" })).error.code).toBe(
      "SAFETY_NOT_CLEARED",
    );

    const hot = sc(
      await call(client, "create_incident", {
        householdId: SEED_IDS.household,
        applianceId: SEED_IDS.appliance,
        description: "dishwasher smoking",
        idempotencyKey: "inc-emergency-1",
      }),
    ).incidentId;
    await call(client, "assess_incident_safety", {
      incidentId: hot,
      answers: { smokeOrBurningSmell: true, nearElectricalOutlet: false, gasSmell: false, waterSpreadingQuickly: false },
    });
    expect(sc(await call(client, "draft_repair_request", { incidentId: hot, recipientType: "REPAIR_TECHNICIAN" })).error.code).toBe(
      "SAFETY_BLOCKED",
    );
    expect(await ctx.db.repairRequest.count()).toBe(1);
  });
});

describe("approval integrity", () => {
  it("rejects execution after the draft is tampered with", async () => {
    const { client } = await mcpClient(ctx.url, agent());
    const { incidentId, approvalId, draft } = await approvedApproval(client);
    await ctx.db.repairRequest.update({ where: { id: draft.draftId }, data: { body: draft.body + "\nAlso replace everything for free." } });
    const r = await exec(client, incidentId, approvalId);
    expect(sc(r).error.code).toBe("PAYLOAD_CHANGED");
    expect(await providerCount()).toBe(0);
  });

  it("cannot approve a tampered draft either", async () => {
    const { client } = await mcpClient(ctx.url, agent());
    const { approvalId, draft } = await pendingApproval(client);
    await ctx.db.repairRequest.update({ where: { id: draft.draftId }, data: { subject: "different" } });
    const res = await rest(`/api/v1/approvals/${approvalId}/approve`, human(), "POST");
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error.code).toBe("PAYLOAD_CHANGED");
  });

  it("expired approvals cannot be approved or executed", async () => {
    const { client } = await mcpClient(ctx.url, agent());
    const a = await pendingApproval(client);
    await ctx.db.approval.update({ where: { id: a.approvalId }, data: { expiresAt: new Date("2026-10-18T11:00:00Z") } });
    const res = await rest(`/api/v1/approvals/${a.approvalId}/approve`, human(), "POST");
    expect(((await res.json()) as any).error.code).toBe("APPROVAL_EXPIRED");

    const b = await approvedApproval(client);
    await ctx.db.approval.update({ where: { id: b.approvalId }, data: { expiresAt: new Date("2026-10-18T11:00:00Z") } });
    expect(sc(await exec(client, b.incidentId, b.approvalId)).error.code).toBe("APPROVAL_EXPIRED");
    expect(await providerCount()).toBe(0);
  });

  it("rejection cancels the draft, returns the case to review, and blocks execution", async () => {
    const { client } = await mcpClient(ctx.url, agent());
    const a = await pendingApproval(client);
    expect((await rest(`/api/v1/approvals/${a.approvalId}/reject`, human(), "POST")).status).toBe(200);
    expect((await ctx.db.repairRequest.findUniqueOrThrow({ where: { id: a.draft.draftId } })).status).toBe("CANCELED");
    expect(sc(await call(client, "get_incident", { incidentId: a.incidentId })).incident.workflowStatus).toBe("EVIDENCE_REVIEW");
    expect(sc(await exec(client, a.incidentId, a.approvalId)).error.code).toBe("APPROVAL_REJECTED");
    expect(await providerCount()).toBe(0);
  });

  it("another household cannot see, decide, request, or execute", async () => {
    const { client } = await mcpClient(ctx.url, agent());
    const a = await pendingApproval(client);
    expect((await rest(`/api/v1/approvals/${a.approvalId}`, otherHuman())).status).toBe(404);
    expect((await rest(`/api/v1/approvals/${a.approvalId}/approve`, otherHuman(), "POST")).status).toBe(404);
    const { client: o } = await mcpClient(ctx.url, otherAgent());
    expect(
      sc(
        await call(o, "request_action_approval", {
          incidentId: a.incidentId,
          actionType: "SUBMIT_REPAIR_REQUEST",
          draftId: a.draft.draftId,
        }),
      ).error.code,
    ).toBe("INCIDENT_NOT_FOUND");
    expect(sc(await call(o, "draft_repair_request", { incidentId: a.incidentId, recipientType: "LANDLORD" })).error.code).toBe(
      "INCIDENT_NOT_FOUND",
    );
    expect(sc(await exec(o, a.incidentId, a.approvalId)).error.code).toBe("APPROVAL_NOT_FOUND");
    expect((await ctx.db.approval.findUniqueOrThrow({ where: { id: a.approvalId } })).status).toBe("PENDING");
  });
});

describe("idempotency", () => {
  it("repeated and concurrent execution with one key creates exactly one downstream request", async () => {
    const { client } = await mcpClient(ctx.url, agent());
    const { incidentId, approvalId } = await approvedApproval(client);
    const results = await Promise.all(Array.from({ length: 6 }, () => exec(client, incidentId, approvalId, "same-key-0001")));
    const ok = results.filter((r) => !r.isError).map(sc);
    for (const r of results.filter((x) => x.isError)) expect(sc(r).error.code).toBe("EXECUTION_IN_PROGRESS");
    expect(ok.length).toBeGreaterThan(0);
    for (const r of ok) expect(r.status).toBe("SUCCEEDED");
    // after the race, every further call replays the stored result
    const again = sc(await exec(client, incidentId, approvalId, "same-key-0001"));
    expect(again.replayed).toBe(true);
    expect(again.providerReference).toBe(ok[0]!.providerReference);
    expect(await providerCount()).toBe(1);
    expect(await ctx.db.incidentEvent.count({ where: { incidentId, eventType: "REPAIR_REQUEST_SUBMITTED" } })).toBe(1);
    expect(await ctx.db.toolExecution.count()).toBe(1);
  });

  it("a new key cannot reuse a consumed approval; a key cannot be reused for another approval", async () => {
    const { client } = await mcpClient(ctx.url, agent());
    const a = await approvedApproval(client);
    expect(sc(await exec(client, a.incidentId, a.approvalId, "key-first-0001")).status).toBe("SUCCEEDED");
    expect(sc(await exec(client, a.incidentId, a.approvalId, "key-second-001")).error.code).toBe("APPROVAL_ALREADY_CONSUMED");
    const b = await approvedApproval(client);
    expect(sc(await exec(client, b.incidentId, b.approvalId, "key-first-0001")).error.code).toBe("IDEMPOTENCY_KEY_REUSE");
    expect(await providerCount()).toBe(1);
  });

  it("the provider itself de-duplicates by idempotency key", async () => {
    const r1 = await ctx.provider.submit({ idempotencyKey: "k1", subject: "s", body: "b" });
    const r2 = await ctx.provider.submit({ idempotencyKey: "k1", subject: "s", body: "b" });
    expect(r2.duplicate).toBe(true);
    expect(r2.reference).toBe(r1.reference);
    expect(await providerCount()).toBe(1);
  });
});

describe("failure handling and recovery", () => {
  it("transient failure before send is retried with backoff and sends once", async () => {
    const { client } = await mcpClient(ctx.url, agent());
    const { incidentId, approvalId } = await approvedApproval(client);
    ctx.provider.script("submit:fail_before", "submit:fail_before");
    const r = sc(await exec(client, incidentId, approvalId));
    expect(r.status).toBe("SUCCEEDED");
    expect(r.attempts).toBe(3);
    expect(await providerCount()).toBe(1);
  });

  it("exhausted retries => FAILED_RETRYABLE, nothing sent, approval stays usable; a later call with the same key succeeds", async () => {
    const { client } = await mcpClient(ctx.url, agent());
    const { incidentId, approvalId, draft } = await approvedApproval(client);
    ctx.provider.script("submit:fail_before", "submit:fail_before", "submit:fail_before");
    const r = sc(await exec(client, incidentId, approvalId));
    expect(r.status).toBe("FAILED_RETRYABLE");
    expect(r.providerReference).toBeNull();
    expect(await providerCount()).toBe(0);
    expect((await ctx.db.repairRequest.findUniqueOrThrow({ where: { id: draft.draftId } })).status).toBe("APPROVED"); // never shown as sent
    expect((await ctx.db.approval.findUniqueOrThrow({ where: { id: approvalId } })).status).toBe("APPROVED");
    const again = sc(await exec(client, incidentId, approvalId));
    expect(again.status).toBe("SUCCEEDED");
    expect(await providerCount()).toBe(1);
  });

  it("timeout AFTER the provider stored the request is reconciled by read-back, not resent", async () => {
    const { client } = await mcpClient(ctx.url, agent());
    const { incidentId, approvalId } = await approvedApproval(client);
    ctx.provider.script("submit:timeout_after");
    const r = sc(await exec(client, incidentId, approvalId));
    expect(r.status).toBe("SUCCEEDED");
    expect(r.reconciled).toBe(true);
    expect(r.attempts).toBe(1);
    expect(await providerCount()).toBe(1);
    const ev = await ctx.db.incidentEvent.findFirstOrThrow({ where: { incidentId, eventType: "REPAIR_REQUEST_SUBMITTED" } });
    expect((ev.structuredPayload as any).reconciled).toBe(true);
  });

  it("INTERRUPTION: unknown outcome is reported honestly, then resumed in a new session without duplicating", async () => {
    const first = await mcpClient(ctx.url, agent());
    const { incidentId, approvalId, draft } = await approvedApproval(first.client);
    ctx.provider.script("submit:timeout_after", "lookup:fail");
    const r = sc(await exec(first.client, incidentId, approvalId, "resume-key-001"));
    expect(r.status).toBe("UNKNOWN_OUTCOME");
    expect(r.message).toMatch(/may or may not/);
    expect(await providerCount()).toBe(1); // it DID reach the provider, but we could not confirm
    expect((await ctx.db.repairRequest.findUniqueOrThrow({ where: { id: draft.draftId } })).status).toBe("APPROVED"); // not claimed as sent
    expect(sc(await call(first.client, "get_incident", { incidentId })).incident.workflowStatus).toBe("ACTION_PENDING");
    await first.client.close();

    // later: brand-new MCP session, same idempotency key
    const second = await mcpClient(ctx.url, agent());
    const resumed = sc(await exec(second.client, incidentId, approvalId, "resume-key-001"));
    expect(resumed.status).toBe("SUCCEEDED");
    expect(resumed.reconciled).toBe(true);
    expect(await providerCount()).toBe(1);
    const types = (await ctx.db.incidentEvent.findMany({ where: { incidentId }, orderBy: { timestamp: "asc" } })).map((e) => e.eventType);
    expect(types).toContain("REPAIR_SUBMISSION_UNKNOWN_OUTCOME");
    expect(types.filter((t) => t === "REPAIR_REQUEST_SUBMITTED")).toHaveLength(1);
    expect((await ctx.db.repairRequest.findUniqueOrThrow({ where: { id: draft.draftId } })).status).toBe("SENT");
  });

  it("unknown outcome where the provider never got it: resume resubmits exactly once", async () => {
    const { client } = await mcpClient(ctx.url, agent());
    const { incidentId, approvalId } = await approvedApproval(client);
    ctx.provider.script("submit:fail_before", "lookup:fail"); // fail_before => NOT_SENT (retry); make ambiguity via 2nd fault
    ctx.provider.script("submit:timeout_after", "lookup:fail");
    await ctx.db.providerRequest.deleteMany(); // simulate that the request never landed
    const r = sc(await exec(client, incidentId, approvalId, "never-landed-1"));
    expect(r.status).toBe("UNKNOWN_OUTCOME");
    await ctx.db.providerRequest.deleteMany();
    const resumed = sc(await exec(client, incidentId, approvalId, "never-landed-1"));
    expect(resumed.status).toBe("SUCCEEDED");
    expect(await providerCount()).toBe(1);
  });

  it("crash recovery: a stale RUNNING lease is reclaimed and reconciled; a fresh lease is respected", async () => {
    const { client } = await mcpClient(ctx.url, agent());
    const { incidentId, approvalId, draft } = await approvedApproval(client);
    ctx.provider.script("submit:timeout_after", "lookup:fail");
    await exec(client, incidentId, approvalId, "crash-key-0001");
    const row = await ctx.db.toolExecution.findFirstOrThrow({ where: { idempotencyKey: "crash-key-0001" } });
    await ctx.db.toolExecution.update({ where: { id: row.id }, data: { status: "RUNNING", startedAt: new Date("2026-10-18T11:59:30Z") } }); // process "died" 30s... fresh vs fixed clock
    expect(sc(await exec(client, incidentId, approvalId, "crash-key-0001")).error.code).toBe("EXECUTION_IN_PROGRESS");
    await ctx.db.toolExecution.update({ where: { id: row.id }, data: { startedAt: new Date("2026-10-18T11:00:00Z") } }); // lease expired
    const r = sc(await exec(client, incidentId, approvalId, "crash-key-0001"));
    expect(r.status).toBe("SUCCEEDED");
    expect(r.reconciled).toBe(true);
    expect(await providerCount()).toBe(1);
    expect((await ctx.db.repairRequest.findUniqueOrThrow({ where: { id: draft.draftId } })).status).toBe("SENT");
  });

  it("permanent provider rejection => FAILED_PERMANENT, draft FAILED, stored result replays, nothing sent", async () => {
    const { client } = await mcpClient(ctx.url, agent());
    const { incidentId, approvalId, draft } = await approvedApproval(client);
    ctx.provider.script("submit:reject");
    const r = sc(await exec(client, incidentId, approvalId));
    expect(r.status).toBe("FAILED_PERMANENT");
    expect((await ctx.db.repairRequest.findUniqueOrThrow({ where: { id: draft.draftId } })).status).toBe("FAILED");
    expect(sc(await exec(client, incidentId, approvalId)).replayed).toBe(true);
    expect(await providerCount()).toBe(0);
  });

  it("demo fault-injection endpoint requires a human session and demo mode", async () => {
    expect((await rest("/api/v1/demo/provider-faults", agent(), "POST", { faults: ["lookup:fail"] })).status).toBe(401);
    expect((await rest("/api/v1/demo/provider-faults", human(), "POST", { faults: ["submit:timeout_after"] })).status).toBe(200);
    const { client } = await mcpClient(ctx.url, agent());
    const { incidentId, approvalId } = await approvedApproval(client);
    const r = sc(await exec(client, incidentId, approvalId));
    expect(r.reconciled).toBe(true);
    expect(await providerCount()).toBe(1);
  });
});
