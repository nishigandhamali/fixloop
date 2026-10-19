import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AppError } from "../errors.js";
import type { Principal } from "../principal.js";
import type { IncidentService } from "../modules/incidents/incident-service.js";

const answersShape = z.object({
  nearElectricalOutlet: z.boolean().optional(),
  smokeOrBurningSmell: z.boolean().optional(),
  gasSmell: z.boolean().optional(),
  waterSpreadingQuickly: z.boolean().optional(),
  freeText: z.string().max(2000).optional(),
});

const ok = <T extends Record<string, unknown>>(structured: T, text: string) => ({
  content: [{ type: "text" as const, text }],
  structuredContent: structured,
});
const fail = (e: unknown) => {
  const known = e instanceof AppError;
  const code = known ? e.code : "INTERNAL_ERROR";
  const message = known ? e.message : "Unexpected error";
  return { isError: true, content: [{ type: "text" as const, text: `${code}: ${message}` }], structuredContent: { error: { code, message } } };
};
const guard = <A>(fn: (a: A) => Promise<ReturnType<typeof ok>>) => async (a: A) => { try { return await fn(a); } catch (e) { return fail(e); } };
const json = (o: unknown) => JSON.parse(JSON.stringify(o)) as Record<string, unknown>;

/**
 * Builds an MCP server bound to ONE authenticated principal. Handlers call application
 * services only (never persistence directly). householdId is never accepted from the agent
 * as trusted: it is verified against the principal.
 */
export function buildMcpServer(svc: IncidentService, p: Principal): McpServer {
  const server = new McpServer({ name: "fixloop", version: "0.1.0" });
  const sameHousehold = (h: string) => { if (h !== p.householdId) throw new AppError("FORBIDDEN", "Not authorized for this household", 403); };
  const ro = { readOnlyHint: true, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

  server.registerTool("list_household_appliances", {
    title: "List household appliances", description: "List appliances registered to the caller's household.",
    inputSchema: { householdId: z.string().uuid() }, annotations: ro,
  }, guard(async ({ householdId }) => {
    sameHousehold(householdId);
    const items = await svc.listAppliances(p);
    return ok({ appliances: json(items) as unknown as unknown[] }, `${items.length} appliance(s)`);
  }));

  server.registerTool("create_incident", {
    title: "Create incident", description: "Open a durable household incident from a user's description. Side-effecting; requires an idempotencyKey so retries do not create duplicates. Owner identity is taken from the authenticated session, not from arguments.",
    inputSchema: { householdId: z.string().uuid(), applianceId: z.string().uuid().optional(), description: z.string().min(3).max(4000), idempotencyKey: z.string().min(8).max(128) },
    annotations: write,
  }, guard(async ({ householdId, applianceId, description, idempotencyKey }) => {
    sameHousehold(householdId);
    const { incident, replayed } = await svc.create(p, { applianceId, description, idempotencyKey });
    return ok({ incidentId: incident.id, status: incident.workflowStatus, severity: incident.severity, replayed,
      nextStep: "Ask the user the safety questions, then call assess_incident_safety." }, `Incident ${incident.id} is ${incident.workflowStatus}`);
  }));

  server.registerTool("assess_incident_safety", {
    title: "Assess incident safety", description: "Run the deterministic safety engine on the user's answers. Always call before offering troubleshooting. Escalation is sticky and cannot be lowered.",
    inputSchema: { incidentId: z.string().uuid(), answers: answersShape }, annotations: write,
  }, guard(async ({ incidentId, answers }) => {
    const r = await svc.assessSafety(p, incidentId, answers);
    return ok({ riskLevel: r.riskLevel, hazards: r.hazards, escalationRequired: r.escalationRequired, safeResponse: r.safeResponse, allowedNextActions: r.allowedNextActions }, r.safeResponse);
  }));

  server.registerTool("get_incident", {
    title: "Get incident", description: "Fetch an incident with its state, recent events and pending approvals.",
    inputSchema: { incidentId: z.string().uuid() }, annotations: ro,
  }, guard(async ({ incidentId }) => {
    const r = await svc.get(p, incidentId);
    return ok(json(r), `Incident ${r.incident.title}: ${r.incident.workflowStatus}`);
  }));

  server.registerTool("list_active_incidents", {
    title: "List active incidents", description: "List unresolved incidents for the household, most recently active first.",
    inputSchema: { householdId: z.string().uuid(), applianceId: z.string().uuid().optional() }, annotations: ro,
  }, guard(async ({ householdId, applianceId }) => {
    sameHousehold(householdId);
    const items = await svc.listActive(p, applianceId);
    return ok({ incidents: json(items) as unknown as unknown[] }, `${items.length} active incident(s)`);
  }));

  server.registerTool("get_incident_timeline", {
    title: "Get incident timeline", description: "Ordered, append-only event history for an incident, with cursor pagination.",
    inputSchema: { incidentId: z.string().uuid(), limit: z.number().int().min(1).max(100).default(50), cursor: z.string().uuid().optional() }, annotations: ro,
  }, guard(async ({ incidentId, limit, cursor }) => {
    const r = await svc.timeline(p, incidentId, { limit, cursor });
    return ok(json(r), `${r.events.length} event(s)`);
  }));

  server.registerTool("resolve_incident", {
    title: "Resolve incident", description: "Mark an incident resolved with a summary. Side-effecting and idempotent.",
    inputSchema: { incidentId: z.string().uuid(), resolutionSummary: z.string().min(1).max(2000), idempotencyKey: z.string().min(8).max(128) }, annotations: write,
  }, guard(async ({ incidentId, resolutionSummary, idempotencyKey }) => {
    const r = await svc.resolve(p, incidentId, resolutionSummary, idempotencyKey);
    return ok({ incidentId, status: r.incident.workflowStatus, replayed: r.replayed }, "Incident resolved");
  }));

  server.registerTool("reopen_incident", {
    title: "Reopen incident", description: "Reopen a resolved incident for re-triage.",
    inputSchema: { incidentId: z.string().uuid(), reason: z.string().min(1).max(1000) }, annotations: write,
  }, guard(async ({ incidentId, reason }) => {
    const r = await svc.reopen(p, incidentId, reason);
    return ok({ incidentId, status: r.incident.workflowStatus }, "Incident reopened");
  }));

  return server;
}
