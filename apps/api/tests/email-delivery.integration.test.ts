import { afterAll, describe, expect, it } from "vitest";
import { EmailRepairProvider, ProviderError, type SubmitRequest } from "../src/adapters/provider.js";
import { FIXTURES, ingestFixture } from "../src/seed-documents.js";
import { mcpClient, SEED_IDS, startApp, tokenFor } from "./helpers.js";

const TECHNICIAN = "tech@repairs.example";

interface Sent {
  to: string[];
  subject: string;
  text: string;
  key: string;
}
/** Fake of the email service: de-duplicates by Idempotency-Key like the real one, and can fail on demand. */
function fakeEmailService() {
  const byKey = new Map<string, string>();
  const sent: Sent[] = [];
  const calls: { key: string; authorization: string }[] = [];
  const script: ("accept_then_timeout" | "reject" | "unavailable")[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    const key = headers["idempotency-key"]!;
    calls.push({ key, authorization: headers.authorization! });
    const fault = script.shift();
    if (fault === "reject") return new Response(JSON.stringify({ message: "invalid recipient" }), { status: 422 });
    if (fault === "unavailable") return new Response("{}", { status: 503 });
    let id = byKey.get(key);
    if (!id) {
      id = `email_${byKey.size + 1}`;
      byKey.set(key, id);
      sent.push({ ...(JSON.parse(init!.body as string) as Omit<Sent, "key">), key });
    }
    if (fault === "accept_then_timeout") throw new Error("socket hang up");
    return new Response(JSON.stringify({ id }), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, sent, calls, script };
}

type Ctx = Awaited<ReturnType<typeof startApp>>;
const opened: Ctx[] = [];
afterAll(async () => {
  for (const c of opened) await c.close().catch(() => undefined);
});
const agent = () => tokenFor(SEED_IDS.user, SEED_IDS.household, "agent");
const human = () => tokenFor(SEED_IDS.user, SEED_IDS.household, "user");
const sc = (r: unknown) => (r as { structuredContent: Record<string, any> }).structuredContent;
const owner = () => ({ userId: SEED_IDS.user, householdId: SEED_IDS.household, role: "OWNER" as const, correlationId: "t" });

async function setup() {
  const svc = fakeEmailService();
  const ctx = await startApp({
    delivery: {
      provider: new EmailRepairProvider({ apiKey: "key-123", from: "FixLoop <fixloop@mail.example>", fetchImpl: svc.fetchImpl }),
      recipients: { REPAIR_TECHNICIAN: TECHNICIAN },
    },
  });
  opened.push(ctx);
  await ingestFixture(ctx.db, ctx.storage, owner(), SEED_IDS.appliance, FIXTURES.manual);
  const { client } = await mcpClient(ctx.url, agent());
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  const rest = (path: string, method = "GET", body?: unknown) =>
    fetch(`${ctx.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${human()}`, "content-type": "application/json" },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    });
  const newClearedIncident = async () => {
    const { incidentId } = sc(
      await call("create_incident", {
        householdId: SEED_IDS.household,
        applianceId: SEED_IDS.appliance,
        description: "My dishwasher is leaking from the door",
        idempotencyKey: `inc-${Math.random().toString(36).slice(2, 12)}`,
      }),
    );
    await call("assess_incident_safety", {
      incidentId,
      answers: { nearElectricalOutlet: false, smokeOrBurningSmell: false, gasSmell: false, waterSpreadingQuickly: false },
    });
    return incidentId as string;
  };
  const incidentId = await newClearedIncident();
  const draft = sc(await call("draft_repair_request", { incidentId, recipientType: "REPAIR_TECHNICIAN" }));
  const approvalId = sc(
    await call("request_action_approval", { incidentId, actionType: "SUBMIT_REPAIR_REQUEST", draftId: draft.draftId }),
  ).approvalId;
  const approve = async () => expect((await rest(`/api/v1/approvals/${approvalId}/approve`, "POST")).status).toBe(200);
  const exec = async () => sc(await call("execute_approved_action", { incidentId, approvalId, idempotencyKey: "exec-key-0001" }));
  return { svc, ctx, call, rest, newClearedIncident, incidentId, draft, approvalId, approve, exec };
}

describe("real email delivery", () => {
  it("drafts with the configured recipient and the owner's contact, and shows both for approval", async () => {
    const t = await setup();
    expect(t.draft.recipientAddress).toBe(TECHNICIAN);
    expect(t.draft.body).not.toMatch(/no real technician/i);
    expect(t.draft.body).toContain("demo@fixloop.example");
    const review = (await (await t.rest(`/api/v1/approvals/${t.approvalId}`)).json()) as any;
    expect(review.action.recipientAddress).toBe(TECHNICIAN);
    expect(t.svc.calls).toHaveLength(0); // nothing is emailed before approval
  });

  it("emails exactly the approved text once, to the approved recipient, and says so honestly", async () => {
    const t = await setup();
    await t.approve();
    const r = await t.exec();
    expect(r.status).toBe("SUCCEEDED");
    expect(r.provider).toBe("EMAIL");
    expect(r.recipientAddress).toBe(TECHNICIAN);
    expect(r.externalCompletionVerified).toBe(false);
    expect(r.message).toMatch(new RegExp(`Emailed to ${TECHNICIAN}`));
    expect(t.svc.sent).toHaveLength(1);
    expect(t.svc.sent[0]).toMatchObject({ to: [TECHNICIAN], subject: t.draft.subject, text: t.draft.body });
    expect(t.svc.calls[0]!.authorization).toBe("Bearer key-123");
    const rr = await t.ctx.db.repairRequest.findUniqueOrThrow({ where: { id: t.draft.draftId } });
    expect(rr).toMatchObject({ status: "SENT", externalProvider: "EMAIL", externalReference: "email_1" });
    expect(await t.ctx.db.providerRequest.count()).toBe(0); // the simulated provider is not involved
    expect((await t.exec()).replayed).toBe(true);
    expect(t.svc.sent).toHaveLength(1);
  });

  it("an email accepted just before a timeout is reconciled by the idempotent retry: one email, no duplicate", async () => {
    const t = await setup();
    await t.approve();
    t.svc.script.push("accept_then_timeout");
    const r = await t.exec();
    expect(r.status).toBe("SUCCEEDED");
    expect(r.attempts).toBe(2);
    expect(t.svc.calls).toHaveLength(2);
    expect(new Set(t.svc.calls.map((c) => c.key)).size).toBe(1);
    expect(t.svc.sent).toHaveLength(1);
  });

  it("retries a temporary outage with the same key and still sends once", async () => {
    const t = await setup();
    await t.approve();
    t.svc.script.push("unavailable", "unavailable");
    expect((await t.exec()).status).toBe("SUCCEEDED");
    expect(t.svc.sent).toHaveLength(1);
  });

  it("does not claim success when every attempt is inconclusive, and a later retry cannot double-send", async () => {
    const t = await setup();
    await t.approve();
    t.svc.script.push("unavailable", "unavailable", "unavailable");
    expect((await t.exec()).status).toBe("FAILED_RETRYABLE");
    expect(t.svc.sent).toHaveLength(0);
    expect((await t.exec()).status).toBe("SUCCEEDED");
    expect(t.svc.sent).toHaveLength(1);
  });

  it("a rejected recipient fails permanently and nothing is sent", async () => {
    const t = await setup();
    await t.approve();
    t.svc.script.push("reject");
    const r = await t.exec();
    expect(r.status).toBe("FAILED_PERMANENT");
    expect(t.svc.sent).toHaveLength(0);
    expect((await t.ctx.db.repairRequest.findUniqueOrThrow({ where: { id: t.draft.draftId } })).status).toBe("FAILED");
  });

  it("the recipient address is covered by the approval: changing it after approval is refused", async () => {
    const t = await setup();
    await t.approve();
    await t.ctx.db.repairRequest.update({ where: { id: t.draft.draftId }, data: { recipientAddress: "someone-else@example.test" } });
    expect((await t.exec()).error.code).toBe("PAYLOAD_CHANGED");
    expect(t.svc.calls).toHaveLength(0);
  });

  it("refuses to draft for a recipient type with no configured address", async () => {
    const t = await setup();
    const r = sc(await t.call("draft_repair_request", { incidentId: await t.newClearedIncident(), recipientType: "LANDLORD" }));
    expect(r.error.code).toBe("RECIPIENT_NOT_CONFIGURED");
  });

  it("simulation-only demo features are unavailable instead of silently sending real email", async () => {
    const t = await setup();
    const faults = await t.rest("/api/v1/demo/provider-faults", "POST", { faults: ["submit:timeout_after"] });
    expect(faults.status).toBe(409);
    expect(((await faults.json()) as any).error.code).toBe("SIMULATION_ONLY");
    for (const scenario of ["resume_incident", "interrupted_submission"]) {
      const res = await t.rest("/api/v1/demo/scenario", "POST", { scenario });
      expect(res.status, scenario).toBe(409);
    }
    expect(t.svc.calls).toHaveLength(0);
  });
});

describe("EmailRepairProvider", () => {
  const req: SubmitRequest = { idempotencyKey: "key-1", recipientAddress: TECHNICIAN, subject: "s", body: "b" };
  const withFetch = (impl: () => Promise<Response>) =>
    new EmailRepairProvider({ apiKey: "k", from: "f@x.test", fetchImpl: impl as typeof fetch });
  const kindOf = async (p: EmailRepairProvider, r = req) => ((await p.submit(r).catch((e) => e)) as ProviderError).kind;

  it("maps outcomes to failure kinds", async () => {
    expect(await kindOf(withFetch(async () => new Response("{}", { status: 200 })))).toBe("AMBIGUOUS"); // accepted but unreadable
    expect(await kindOf(withFetch(async () => new Response("{}", { status: 429 })))).toBe("AMBIGUOUS");
    expect(await kindOf(withFetch(async () => new Response("{}", { status: 500 })))).toBe("AMBIGUOUS");
    expect(await kindOf(withFetch(async () => Promise.reject(new Error("ECONNRESET"))))).toBe("AMBIGUOUS");
    expect(await kindOf(withFetch(async () => new Response("{}", { status: 401 })))).toBe("PERMANENT");
    expect(await kindOf(withFetch(async () => new Response("{}", { status: 422 })))).toBe("PERMANENT");
    expect(
      await kindOf(
        withFetch(async () => new Response("{}", { status: 200 })),
        { ...req, recipientAddress: null },
      ),
    ).toBe("PERMANENT");
  });

  it("returns the service's message id as the reference", async () => {
    const p = withFetch(async () => new Response(JSON.stringify({ id: "abc" }), { status: 200 }));
    expect((await p.submit(req)).reference).toBe("abc");
    expect(await p.lookup()).toBeNull();
  });
});
